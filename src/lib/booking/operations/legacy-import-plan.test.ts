import assert from "node:assert/strict";
import test from "node:test";

import { buildLegacyBookingImportPlan } from "./legacy-import-plan";

const settings = {
  bookingHorizonDays: 45,
  bufferMinutes: 15,
  calendarId: "primary",
  hoursOfOperation: [
    {
      day: "monday" as const,
      isOpen: true,
      opensAt: "10:00",
      closesAt: "18:00",
    },
    {
      day: "sunday" as const,
      isOpen: false,
      opensAt: "10:00",
      closesAt: "16:00",
    },
  ],
  minimumLeadTimeHours: 24,
  slotIntervalMinutes: 15,
  timezone: "America/Toronto",
};

test("builds a draft-ready Nataliea import plan without carrying the global calendar alias", () => {
  const plan = buildLegacyBookingImportPlan({
    effectiveFrom: "2032-01-15",
    services: [
      {
        addOns: [
          {
            description: "Removal before service",
            key: "removal",
            name: "Removal",
            priceCad: 25.5,
          },
        ],
        depositCad: 40,
        description: "A full classic lash set.",
        durationMinutes: 90,
        fullPriceCad: 120,
        sanityDocumentId: "service-classic",
        slug: "classic-set",
        title: "Classic Set",
      },
    ],
    settings,
  });

  assert.deepEqual(plan.provider, {
    displayName: "Nataliea",
    providerKey: "nataliea",
    publicSlug: "nataliea",
  });
  assert.equal(plan.offerings[0]?.offeringKey, "classic-set-nataliea");
  assert.equal(plan.offerings[0]?.fullPriceCents, 12_000);
  assert.equal(plan.offerings[0]?.depositAmountCents, 4_000);
  assert.equal(plan.offerings[0]?.addOns[0]?.priceCents, 2_550);
  assert.equal(plan.offerings[0]?.publicTitle, "Classic Set");
  assert.equal(plan.offerings[0]?.publicSummary, "A full classic lash set.");
  assert.deepEqual(plan.schedules, [
    {
      effectiveFrom: "2032-01-15",
      endsAt: "18:00",
      startsAt: "10:00",
      timezone: "America/Toronto",
      weekday: 1,
    },
  ]);
  assert.equal(plan.warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(plan), /"calendarId"|"primary"/);
});

test("rejects duplicate services, unsafe keys, invalid money, and closed schedules", () => {
  const service = {
    depositCad: 40,
    durationMinutes: 90,
    fullPriceCad: 120,
    sanityDocumentId: "service-classic",
    slug: "classic-set",
    title: "Classic Set",
  };

  assert.throws(
    () =>
      buildLegacyBookingImportPlan({
        effectiveFrom: "2032-01-15",
        services: [service, service],
        settings,
      }),
    /Duplicate legacy service slug/,
  );
  assert.throws(
    () =>
      buildLegacyBookingImportPlan({
        effectiveFrom: "2032-01-15",
        providerSlug: "Nataliea / Owner",
        services: [service],
        settings,
      }),
    /Provider slug/,
  );
  assert.throws(
    () =>
      buildLegacyBookingImportPlan({
        effectiveFrom: "2032-01-15",
        services: [{ ...service, fullPriceCad: 120.005 }],
        settings,
      }),
    /at most two decimals/,
  );
  assert.throws(
    () =>
      buildLegacyBookingImportPlan({
        effectiveFrom: "2032-01-15",
        services: [service],
        settings: {
          ...settings,
          hoursOfOperation: settings.hoursOfOperation.map((window) => ({
            ...window,
            isOpen: false,
          })),
        },
      }),
    /At least one open/,
  );
  assert.throws(
    () =>
      buildLegacyBookingImportPlan({
        effectiveFrom: "2032-01-15",
        services: [{ ...service, shortDescription: "x".repeat(501) }],
        settings,
      }),
    /public summary must be 500 characters or fewer/,
  );
});
