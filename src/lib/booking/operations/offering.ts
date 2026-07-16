export type OperationalRecordStatus = "active" | "archived" | "disabled" | "draft";

export interface OperationalBookingAddOn {
  description: string;
  durationDeltaMinutes: number;
  key: string;
  name: string;
  priceCents: number;
  status: "active" | "disabled";
}

export interface OperationalBookingOffering {
  addOns: OperationalBookingAddOn[];
  bookingType: "in-person-appointment";
  bufferAfterMinutes: number;
  bufferBeforeMinutes: number;
  calendar: {
    assignmentId: string;
    calendarId: string;
    connectionId: string;
  };
  currency: "CAD";
  depositAmountCents: number;
  durationMinutes: number;
  fullPriceCents: number;
  horizonDays: number;
  id: string;
  minimumLeadTimeHours: number;
  offeringKey: string;
  provider: {
    displayName: string;
    id: string;
    providerKey: string;
    publicSlug?: string;
    squareTeamMemberId?: string;
    status: OperationalRecordStatus;
  };
  resource: {
    id: string;
    name: string;
    resourceKey: string;
    status: OperationalRecordStatus;
    timezone: string;
  };
  service: {
    displayTitle: string;
    id: string;
    publicSlug?: string;
    sanityDocumentId?: string;
    serviceKey: string;
    status: OperationalRecordStatus;
  };
  slotIntervalMinutes: number;
  status: OperationalRecordStatus;
  version: number;
}

export interface PublicBookingOfferingAddOn {
  description: string;
  durationDeltaMinutes: number;
  key: string;
  name: string;
  priceCents: number;
}

/**
 * Explicit browser-safe projection. Operational resource, Calendar assignment,
 * connection, provider, and service identifiers are intentionally absent.
 */
export interface PublicBookingOffering {
  addOns: PublicBookingOfferingAddOn[];
  depositAmountCents: number;
  durationMinutes: number;
  fullPriceCents: number;
  id: string;
  offeringKey: string;
  provider: {
    displayName: string;
    publicSlug?: string;
  };
  serviceSlug: string;
  serviceTitle: string;
}

export type PublicServiceBookingModel = "legacy" | "operational";

export interface ResolvedOperationalBooking {
  bookingModelVersion: 2;
  calendar: OperationalBookingOffering["calendar"];
  configurationVersion: number;
  durationMinutes: number;
  occupiedEnd: Date;
  occupiedStart: Date;
  offeringId: string;
  offeringKey: string;
  pricing: {
    addOnPriceCents: number;
    currency: "CAD";
    depositAmountCents: number;
    fullPriceCents: number;
  };
  providerId: string;
  providerSnapshot: {
    displayName: string;
    providerKey: string;
    publicSlug?: string;
    squareTeamMemberId?: string;
  };
  resourceId: string;
  selectedAddOn?: {
    description: string;
    durationDeltaMinutes: number;
    key: string;
    name: string;
    priceCents: number;
  };
  selectedEnd: Date;
  selectedStart: Date;
  serviceSnapshot: {
    displayTitle: string;
    publicSlug?: string;
    sanityDocumentId?: string;
    serviceId: string;
    serviceKey: string;
  };
  timezone: string;
}

export type ResolveOperationalBookingResult =
  | { ok: true; booking: ResolvedOperationalBooking }
  | {
      ok: false;
      reason:
        | "invalid_configuration"
        | "invalid_start"
        | "not_bookable"
        | "selected_add_on_unavailable";
    };

const MINUTE_MS = 60_000;

export function resolveOperationalBooking(input: {
  offering: OperationalBookingOffering;
  selectedAddOnKey?: string;
  selectedStart: Date;
}): ResolveOperationalBookingResult {
  const { offering, selectedStart } = input;

  if (!isBookable(offering)) {
    return { ok: false, reason: "not_bookable" };
  }

  if (!isValidOfferingConfiguration(offering)) {
    return { ok: false, reason: "invalid_configuration" };
  }

  if (Number.isNaN(selectedStart.getTime())) {
    return { ok: false, reason: "invalid_start" };
  }

  const selectedAddOn = input.selectedAddOnKey
    ? offering.addOns.find(
        (addOn) =>
          addOn.key === input.selectedAddOnKey && addOn.status === "active",
      )
    : undefined;

  if (input.selectedAddOnKey && selectedAddOn === undefined) {
    return { ok: false, reason: "selected_add_on_unavailable" };
  }

  if (selectedAddOn && !isValidOperationalBookingAddOn(selectedAddOn)) {
    return { ok: false, reason: "invalid_configuration" };
  }

  const durationMinutes =
    offering.durationMinutes + (selectedAddOn?.durationDeltaMinutes ?? 0);
  const selectedEnd = addMinutes(selectedStart, durationMinutes);
  const occupiedStart = addMinutes(selectedStart, -offering.bufferBeforeMinutes);
  const occupiedEnd = addMinutes(selectedEnd, offering.bufferAfterMinutes);

  return {
    ok: true,
    booking: {
      bookingModelVersion: 2,
      calendar: { ...offering.calendar },
      configurationVersion: offering.version,
      durationMinutes,
      occupiedEnd,
      occupiedStart,
      offeringId: offering.id,
      offeringKey: offering.offeringKey,
      pricing: {
        addOnPriceCents: selectedAddOn?.priceCents ?? 0,
        currency: offering.currency,
        depositAmountCents: offering.depositAmountCents,
        fullPriceCents: offering.fullPriceCents,
      },
      providerId: offering.provider.id,
      providerSnapshot: {
        displayName: offering.provider.displayName,
        providerKey: offering.provider.providerKey,
        ...(offering.provider.publicSlug
          ? { publicSlug: offering.provider.publicSlug }
          : {}),
        ...(offering.provider.squareTeamMemberId
          ? { squareTeamMemberId: offering.provider.squareTeamMemberId }
          : {}),
      },
      resourceId: offering.resource.id,
      ...(selectedAddOn
        ? {
            selectedAddOn: {
              description: selectedAddOn.description,
              durationDeltaMinutes: selectedAddOn.durationDeltaMinutes,
              key: selectedAddOn.key,
              name: selectedAddOn.name,
              priceCents: selectedAddOn.priceCents,
            },
          }
        : {}),
      selectedEnd,
      selectedStart: new Date(selectedStart),
      serviceSnapshot: {
        displayTitle: offering.service.displayTitle,
        serviceId: offering.service.id,
        serviceKey: offering.service.serviceKey,
        ...(offering.service.publicSlug
          ? { publicSlug: offering.service.publicSlug }
          : {}),
        ...(offering.service.sanityDocumentId
          ? { sanityDocumentId: offering.service.sanityDocumentId }
          : {}),
      },
      timezone: offering.resource.timezone,
    },
  };
}

export function toPublicBookingOffering(
  offering: OperationalBookingOffering,
): PublicBookingOffering | null {
  const serviceSlug = offering.service.publicSlug?.trim();
  const serviceTitle = offering.service.displayTitle.trim();
  const providerDisplayName = offering.provider.displayName.trim();
  const offeringKey = offering.offeringKey.trim();
  const providerPublicSlug = offering.provider.publicSlug?.trim();
  const activeAddOns = offering.addOns.filter(
    (addOn) => addOn.status === "active",
  );

  if (
    !isBookable(offering) ||
    !isValidOfferingConfiguration(offering) ||
    serviceSlug === undefined ||
    serviceSlug.length === 0 ||
    serviceTitle.length === 0 ||
    providerDisplayName.length === 0 ||
    offeringKey.length === 0 ||
    !activeAddOns.every(isValidOperationalBookingAddOn)
  ) {
    return null;
  }

  return {
    addOns: activeAddOns.map((addOn) => ({
      description: addOn.description,
      durationDeltaMinutes: addOn.durationDeltaMinutes,
      key: addOn.key,
      name: addOn.name,
      priceCents: addOn.priceCents,
    })),
    depositAmountCents: offering.depositAmountCents,
    durationMinutes: offering.durationMinutes,
    fullPriceCents: offering.fullPriceCents,
    id: offering.id,
    offeringKey,
    provider: {
      displayName: providerDisplayName,
      ...(providerPublicSlug ? { publicSlug: providerPublicSlug } : {}),
    },
    serviceSlug,
    serviceTitle,
  };
}

function isBookable(offering: OperationalBookingOffering): boolean {
  return (
    offering.status === "active" &&
    offering.provider.status === "active" &&
    offering.resource.status === "active" &&
    offering.service.status === "active"
  );
}

function isValidOfferingConfiguration(
  offering: OperationalBookingOffering,
): boolean {
  return (
    offering.id.trim().length > 0 &&
    offering.provider.id.trim().length > 0 &&
    offering.resource.id.trim().length > 0 &&
    offering.service.id.trim().length > 0 &&
    offering.calendar.assignmentId.trim().length > 0 &&
    offering.calendar.connectionId.trim().length > 0 &&
    offering.calendar.calendarId.trim().length > 0 &&
    offering.calendar.calendarId !== "primary" &&
    Number.isInteger(offering.durationMinutes) &&
    offering.durationMinutes > 0 &&
    Number.isInteger(offering.slotIntervalMinutes) &&
    offering.slotIntervalMinutes > 0 &&
    Number.isInteger(offering.bufferBeforeMinutes) &&
    offering.bufferBeforeMinutes >= 0 &&
    Number.isInteger(offering.bufferAfterMinutes) &&
    offering.bufferAfterMinutes >= 0 &&
    Number.isInteger(offering.fullPriceCents) &&
    offering.fullPriceCents > 0 &&
    Number.isInteger(offering.depositAmountCents) &&
    offering.depositAmountCents > 0 &&
    offering.depositAmountCents < offering.fullPriceCents &&
    Number.isInteger(offering.version) &&
    offering.version > 0
  );
}

export function isValidOperationalBookingAddOn(
  addOn: OperationalBookingAddOn,
): boolean {
  return (
    addOn.key.trim().length > 0 &&
    addOn.name.trim().length > 0 &&
    addOn.description.trim().length > 0 &&
    Number.isInteger(addOn.priceCents) &&
    addOn.priceCents >= 0 &&
    Number.isInteger(addOn.durationDeltaMinutes) &&
    addOn.durationDeltaMinutes >= 0
  );
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}
