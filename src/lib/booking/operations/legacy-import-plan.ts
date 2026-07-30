import type { BookingHoursWindow, BookingWeekday } from "@/lib/booking/types";

export interface LegacyBookingImportAddOn {
  description?: string;
  key: string;
  name: string;
  priceCad: number;
}

export interface LegacyBookingImportService {
  addOns?: LegacyBookingImportAddOn[];
  depositCad: number;
  description?: string;
  durationMinutes: number;
  fullPriceCad: number;
  sanityDocumentId: string;
  shortDescription?: string;
  slug: string;
  title: string;
}

export interface LegacyBookingImportSettings {
  bookingHorizonDays: number;
  bufferMinutes: number;
  calendarId?: string;
  hoursOfOperation: BookingHoursWindow[];
  minimumLeadTimeHours: number;
  slotIntervalMinutes: number;
  timezone: string;
}

export interface LegacyBookingImportPlan {
  businessSettings: {
    bookingHorizonDays: number;
    defaultBufferAfterMinutes: number;
    defaultBufferBeforeMinutes: number;
    minimumLeadTimeHours: number;
    slotIntervalMinutes: number;
    timezone: string;
  };
  offerings: Array<{
    addOns: Array<{
      addOnKey: string;
      description: string | null;
      durationDeltaMinutes: number;
      name: string;
      priceCents: number;
    }>;
    bufferAfterMinutes: number;
    bufferBeforeMinutes: number;
    depositAmountCents: number;
    durationMinutes: number;
    fullPriceCents: number;
    offeringKey: string;
    publicSummary: string;
    publicTitle: string;
    service: {
      displayTitle: string;
      publicSlug: string;
      sanityDocumentId: string;
      serviceKey: string;
    };
    slotIntervalMinutes: number;
  }>;
  provider: {
    displayName: string;
    providerKey: string;
    publicSlug: string;
  };
  resource: {
    kind: "provider";
    name: string;
    resourceKey: string;
    timezone: string;
  };
  schedules: Array<{
    effectiveFrom: string;
    endsAt: string;
    startsAt: string;
    timezone: string;
    weekday: number;
  }>;
  warnings: string[];
}

const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ADD_ON_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAY_NUMBER: Record<BookingWeekday, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

export function buildLegacyBookingImportPlan(input: {
  effectiveFrom: string;
  providerName?: string;
  providerSlug?: string;
  services: LegacyBookingImportService[];
  settings: LegacyBookingImportSettings;
}): LegacyBookingImportPlan {
  const providerName = requireText(
    input.providerName ?? "Nataliea",
    "Provider name",
  );
  const providerKey = requireKey(
    input.providerSlug ?? "nataliea",
    "Provider slug",
  );
  const settings = validateSettings(input.settings);
  const effectiveFrom = requireIsoDate(input.effectiveFrom);

  if (input.services.length === 0) {
    throw new Error("At least one legacy bookable service is required");
  }

  const seenServiceKeys = new Set<string>();
  const offerings = input.services.map((service) => {
    const serviceKey = requireKey(service.slug, "Service slug");

    if (seenServiceKeys.has(serviceKey)) {
      throw new Error(`Duplicate legacy service slug: ${serviceKey}`);
    }
    seenServiceKeys.add(serviceKey);

    const fullPriceCents = toCents(
      service.fullPriceCad,
      `${service.title} full price`,
    );
    const depositAmountCents = toCents(
      service.depositCad,
      `${service.title} deposit`,
    );

    if (depositAmountCents >= fullPriceCents) {
      throw new Error(`${service.title} deposit must be lower than full price`);
    }

    if (
      !Number.isInteger(service.durationMinutes) ||
      service.durationMinutes <= 0
    ) {
      throw new Error(
        `${service.title} duration must be a positive whole number`,
      );
    }

    const addOnKeys = new Set<string>();
    const addOns = (service.addOns ?? []).map((addOn) => {
      const addOnKey = requireAddOnKey(
        addOn.key,
        `${service.title} add-on key`,
      );

      if (addOnKeys.has(addOnKey)) {
        throw new Error(
          `Duplicate add-on key ${addOnKey} for ${service.title}`,
        );
      }
      addOnKeys.add(addOnKey);

      return {
        addOnKey,
        description: cleanOptionalText(addOn.description) ?? null,
        durationDeltaMinutes: 0,
        name: requireText(addOn.name, `${service.title} add-on name`),
        priceCents: toCents(addOn.priceCad, `${service.title} add-on price`),
      };
    });

    const displayTitle = requireBoundedText(
      service.title,
      "Service title",
      160,
    );
    const publicSummary = requireBoundedText(
      cleanOptionalText(service.shortDescription) ??
        cleanOptionalText(service.description) ??
        `Book ${displayTitle} with ${providerName}.`,
      `${displayTitle} public summary`,
      500,
    );

    return {
      addOns,
      bufferAfterMinutes: settings.bufferMinutes,
      bufferBeforeMinutes: settings.bufferMinutes,
      depositAmountCents,
      durationMinutes: service.durationMinutes,
      fullPriceCents,
      offeringKey: `${serviceKey}-${providerKey}`,
      publicSummary,
      publicTitle: displayTitle,
      service: {
        displayTitle,
        publicSlug: serviceKey,
        sanityDocumentId: requireText(
          service.sanityDocumentId,
          `${service.title} Sanity document ID`,
        ),
        serviceKey,
      },
      slotIntervalMinutes: settings.slotIntervalMinutes,
    };
  });
  const schedules = settings.hoursOfOperation
    .filter((window) => window.isOpen)
    .map((window) => {
      if (
        !TIME_PATTERN.test(window.opensAt) ||
        !TIME_PATTERN.test(window.closesAt)
      ) {
        throw new Error(`Invalid ${window.day} booking hours`);
      }
      if (window.opensAt >= window.closesAt) {
        throw new Error(
          `${window.day} closing time must be after opening time`,
        );
      }

      return {
        effectiveFrom,
        endsAt: window.closesAt,
        startsAt: window.opensAt,
        timezone: settings.timezone,
        weekday: WEEKDAY_NUMBER[window.day],
      };
    });

  if (schedules.length === 0) {
    throw new Error(
      "At least one open legacy booking-hours window is required",
    );
  }

  const warnings: string[] = [];
  if (cleanOptionalText(settings.calendarId)) {
    warnings.push(
      "The legacy calendar ID and global OAuth token are not imported. Connect and select a canonical provider calendar in Admin before activation.",
    );
  }

  return {
    businessSettings: {
      bookingHorizonDays: settings.bookingHorizonDays,
      defaultBufferAfterMinutes: settings.bufferMinutes,
      defaultBufferBeforeMinutes: settings.bufferMinutes,
      minimumLeadTimeHours: settings.minimumLeadTimeHours,
      slotIntervalMinutes: settings.slotIntervalMinutes,
      timezone: settings.timezone,
    },
    offerings,
    provider: {
      displayName: providerName,
      providerKey,
      publicSlug: providerKey,
    },
    resource: {
      kind: "provider",
      name: providerName,
      resourceKey: providerKey,
      timezone: settings.timezone,
    },
    schedules,
    warnings,
  };
}

function validateSettings(
  settings: LegacyBookingImportSettings,
): LegacyBookingImportSettings {
  assertPositiveInteger(settings.bookingHorizonDays, "Booking horizon days");
  assertNonnegativeInteger(
    settings.minimumLeadTimeHours,
    "Minimum lead time hours",
  );
  assertPositiveInteger(settings.slotIntervalMinutes, "Slot interval minutes");
  assertNonnegativeInteger(settings.bufferMinutes, "Buffer minutes");
  requireText(settings.timezone, "Timezone");

  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone }).format();
  } catch {
    throw new Error("Timezone must be a valid IANA timezone");
  }

  return settings;
}

function toCents(amount: number, label: string): number {
  const cents = Math.round(amount * 100);

  if (
    !Number.isFinite(amount) ||
    cents <= 0 ||
    Math.abs(cents / 100 - amount) > 1e-9
  ) {
    throw new Error(
      `${label} must be a positive amount with at most two decimals`,
    );
  }

  return cents;
}

function requireText(value: string, label: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${label} is required`);
  return cleaned;
}

function requireBoundedText(
  value: string,
  label: string,
  maxLength: number,
): string {
  const cleaned = requireText(value, label);
  if (cleaned.length > maxLength) {
    throw new Error(`${label} must be ${maxLength} characters or fewer`);
  }
  return cleaned;
}

function cleanOptionalText(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned || undefined;
}

function requireKey(value: string, label: string): string {
  const cleaned = value.trim().toLowerCase();
  if (!KEY_PATTERN.test(cleaned)) {
    throw new Error(
      `${label} must contain lowercase letters, numbers, and hyphens only`,
    );
  }
  return cleaned;
}

function requireAddOnKey(value: string, label: string): string {
  const cleaned = value.trim().toLowerCase();
  if (!ADD_ON_KEY_PATTERN.test(cleaned)) {
    throw new Error(
      `${label} must contain letters, numbers, underscores, or hyphens`,
    );
  }
  return cleaned;
}

function requireIsoDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Effective date must use YYYY-MM-DD");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error("Effective date is invalid");
  }
  return value;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive whole number`);
  }
}

function assertNonnegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative whole number`);
  }
}
