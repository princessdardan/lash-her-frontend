import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveOperationalBooking,
  toPublicBookingOffering,
  type OperationalBookingOffering,
} from "./offering";

describe("resolveOperationalBooking", () => {
  it("resolves immutable provider, service, pricing, calendar, and occupied intervals", () => {
    const result = resolveOperationalBooking({
      offering: createOffering(),
      selectedAddOnKey: "lash-bath",
      selectedStart: new Date("2026-07-20T14:00:00.000Z"),
    });

    assert.equal(result.ok, true);

    if (!result.ok) {
      return;
    }

    assert.equal(result.booking.bookingModelVersion, 2);
    assert.equal(result.booking.durationMinutes, 75);
    assert.equal(
      result.booking.selectedEnd.toISOString(),
      "2026-07-20T15:15:00.000Z",
    );
    assert.equal(
      result.booking.occupiedStart.toISOString(),
      "2026-07-20T13:50:00.000Z",
    );
    assert.equal(
      result.booking.occupiedEnd.toISOString(),
      "2026-07-20T15:35:00.000Z",
    );
    assert.equal(result.booking.pricing.addOnPriceCents, 1500);
    assert.equal(result.booking.providerSnapshot.displayName, "Nataliea");
    assert.equal(result.booking.squareTeamMemberId, "square-team-member-1");
    assert.equal(
      JSON.stringify(result.booking.providerSnapshot).includes(
        "square-team-member-1",
      ),
      false,
    );
    assert.equal(result.booking.calendar.calendarId, "calendar@example.com");
  });

  it("rejects an unavailable add-on without falling back silently", () => {
    const result = resolveOperationalBooking({
      offering: createOffering(),
      selectedAddOnKey: "removed-add-on",
      selectedStart: new Date("2026-07-20T14:00:00.000Z"),
    });

    assert.deepEqual(result, {
      ok: false,
      reason: "selected_add_on_unavailable",
    });
  });

  it("rejects malformed active add-on configuration", () => {
    const offering = createOffering();
    offering.addOns[0].durationDeltaMinutes = -15;

    assert.deepEqual(
      resolveOperationalBooking({
        offering,
        selectedAddOnKey: "lash-bath",
        selectedStart: new Date("2026-07-20T14:00:00.000Z"),
      }),
      { ok: false, reason: "invalid_configuration" },
    );
  });

  it("rejects inactive related records", () => {
    const offering = createOffering();
    offering.provider.status = "disabled";

    assert.deepEqual(
      resolveOperationalBooking({
        offering,
        selectedStart: new Date("2026-07-20T14:00:00.000Z"),
      }),
      { ok: false, reason: "not_bookable" },
    );
  });

  it("rejects contextual primary calendar aliases", () => {
    const offering = createOffering();
    offering.calendar.calendarId = "primary";

    assert.deepEqual(
      resolveOperationalBooking({
        offering,
        selectedStart: new Date("2026-07-20T14:00:00.000Z"),
      }),
      { ok: false, reason: "invalid_configuration" },
    );
  });

  it("books without a Sanity link but requires the public service slug", () => {
    const offering = createOffering();
    offering.service.sanityDocumentId = undefined;

    assert.equal(
      resolveOperationalBooking({
        offering,
        selectedStart: new Date("2026-07-20T14:00:00.000Z"),
      }).ok,
      true,
    );

    offering.service.publicSlug = undefined;
    assert.deepEqual(
      resolveOperationalBooking({
        offering,
        selectedStart: new Date("2026-07-20T14:00:00.000Z"),
      }),
      { ok: false, reason: "invalid_configuration" },
    );
  });
});

describe("toPublicBookingOffering", () => {
  it("projects only public booking configuration and active add-ons", () => {
    const offering = createOffering();
    offering.addOns.push({
      description: "No longer offered",
      durationDeltaMinutes: 0,
      key: "disabled-addon",
      name: "Disabled add-on",
      priceCents: 500,
      status: "disabled",
    });

    const projected = toPublicBookingOffering(offering);

    assert.deepEqual(projected, {
      addOns: [
        {
          description: "Extended lash bath",
          durationDeltaMinutes: 15,
          key: "lash-bath",
          name: "Lash bath",
          priceCents: 1500,
        },
      ],
      depositAmountCents: 5000,
      displayOrder: 4,
      durationMinutes: 60,
      fullPriceCents: 15000,
      hasEditorialDetail: true,
      id: "offering-1",
      offeringKey: "classic-fill-nataliea",
      provider: {
        displayName: "Nataliea",
        providerKey: "nataliea",
        publicSlug: "nataliea",
      },
      publicSummary: "A provider-specific classic fill.",
      publicTitle: "Nataliea's Classic Fill",
      serviceSlug: "classic-fill",
      serviceTitle: "Classic Fill",
    });

    const serialized = JSON.stringify(projected);
    assert.doesNotMatch(
      serialized,
      /assignment-1|calendar@example\.com|connection-1|provider-1|resource-1|service-1|square-team-member-1/,
    );
  });

  it("rejects route-unsafe operational slugs", () => {
    const unsafeService = createOffering();
    unsafeService.service.publicSlug = "../classic-fill";
    assert.equal(toPublicBookingOffering(unsafeService), null);

    const unsafeProvider = createOffering();
    unsafeProvider.provider.publicSlug = "Nataliea / Owner";
    assert.equal(toPublicBookingOffering(unsafeProvider), null);
  });
});

function createOffering(): OperationalBookingOffering {
  return {
    addOns: [
      {
        description: "Extended lash bath",
        durationDeltaMinutes: 15,
        key: "lash-bath",
        name: "Lash bath",
        priceCents: 1500,
        status: "active",
      },
    ],
    bookingType: "in-person-appointment",
    bufferAfterMinutes: 20,
    bufferBeforeMinutes: 10,
    calendar: {
      assignmentId: "assignment-1",
      calendarId: "calendar@example.com",
      connectionId: "connection-1",
    },
    currency: "CAD",
    depositAmountCents: 5000,
    displayOrder: 4,
    durationMinutes: 60,
    fullPriceCents: 15000,
    horizonDays: 30,
    id: "offering-1",
    minimumLeadTimeHours: 24,
    offeringKey: "classic-fill-nataliea",
    publicSummary: "A provider-specific classic fill.",
    publicTitle: "Nataliea's Classic Fill",
    provider: {
      displayName: "Nataliea",
      id: "provider-1",
      providerKey: "nataliea",
      publicSlug: "nataliea",
      squareTeamMemberId: "square-team-member-1",
      status: "active",
    },
    resource: {
      id: "resource-1",
      name: "Nataliea",
      resourceKey: "provider-nataliea",
      status: "active",
      timezone: "America/Toronto",
    },
    service: {
      displayTitle: "Classic Fill",
      id: "service-1",
      publicSlug: "classic-fill",
      sanityDocumentId: "sanity-service-1",
      serviceKey: "classic-fill",
      status: "active",
    },
    slotIntervalMinutes: 15,
    status: "active",
    version: 3,
  };
}
