import assert from "node:assert/strict";
import test from "node:test";

import type { OperationalBookingOffering } from "./offering";
import {
  buildOperationalBookingSlots,
  isResolvedOperationalBookingAvailable,
  loadOperationalAvailabilityContext,
  type OperationalAvailabilityDependencies,
} from "./availability";
import { resolveOperationalBooking } from "./offering";

const NOW = new Date("2030-06-03T08:00:00.000Z");

test("operational availability intersects resource schedules and uses assigned connections", async () => {
  const offering = createOffering();
  const calendarCalls: Array<{ calendarId: string; connectionId: string }> = [];
  const dependencies = createDependencies(offering, {
    listConnectionCalendarEvents: async (input) => {
      calendarCalls.push({
        calendarId: input.calendarId,
        connectionId: input.connectionId,
      });

      return input.calendarId === "secondary-calendar@example.com"
        ? [
            {
              end: new Date("2030-06-03T13:00:00.000Z"),
              id: "secondary-busy",
              start: new Date("2030-06-03T12:00:00.000Z"),
              title: "Secondary resource busy",
            },
          ]
        : [];
    },
  });

  const result = await loadOperationalAvailabilityContext({
    dependencies,
    now: NOW,
    offeringId: offering.id,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(calendarCalls, [
    {
      calendarId: "provider-calendar@example.com",
      connectionId: "connection-provider",
    },
    {
      calendarId: "secondary-calendar@example.com",
      connectionId: "connection-secondary",
    },
  ]);
  assert.deepEqual(
    result.context.availabilityWindows.map((window) => [
      window.start.toISOString(),
      window.end.toISOString(),
    ]),
    [["2030-06-03T10:00:00.000Z", "2030-06-03T16:00:00.000Z"]],
  );

  const slots = buildOperationalBookingSlots(result.context);
  assert.equal(slots[0]?.start, "2030-06-03T10:30:00.000Z");
  assert.equal(
    slots.some((slot) => slot.start === "2030-06-03T12:00:00.000Z"),
    false,
  );
  assert.equal(
    slots.some((slot) => slot.start === "2030-06-03T14:00:00.000Z"),
    false,
  );
});

test("hold revalidation uses server-resolved add-on duration and occupied buffers", async () => {
  const offering = createOffering();
  const result = await loadOperationalAvailabilityContext({
    dependencies: createDependencies(offering),
    now: NOW,
    offeringId: offering.id,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const available = resolveOperationalBooking({
    offering,
    selectedAddOnKey: "lash-bath",
    selectedStart: new Date("2030-06-03T10:30:00.000Z"),
  });
  const outsideSchedule = resolveOperationalBooking({
    offering,
    selectedAddOnKey: "lash-bath",
    selectedStart: new Date("2030-06-03T15:00:00.000Z"),
  });
  assert.equal(available.ok, true);
  assert.equal(outsideSchedule.ok, true);

  if (available.ok && outsideSchedule.ok) {
    assert.equal(
      isResolvedOperationalBookingAvailable({
        booking: available.booking,
        context: result.context,
      }),
      true,
    );
    assert.equal(
      isResolvedOperationalBookingAvailable({
        booking: outsideSchedule.booking,
        context: result.context,
      }),
      false,
    );
  }
});

test("operational availability fails closed when a required resource is missing", async () => {
  const offering = createOffering();
  const dependencies = createDependencies(offering, {
    getOfferingAvailabilityConfiguration: async () => ({
      requiredResourceIds: ["resource-provider", "resource-room"],
      resources: [],
    }),
  });

  assert.deepEqual(
    await loadOperationalAvailabilityContext({
      dependencies,
      now: NOW,
      offeringId: offering.id,
    }),
    { ok: false, reason: "invalid_configuration" },
  );
});

function createDependencies(
  offering: OperationalBookingOffering,
  overrides: Partial<OperationalAvailabilityDependencies> = {},
): OperationalAvailabilityDependencies {
  return {
    findActiveOfferingById: async ({ id }) =>
      id === offering.id ? offering : null,
    getOfferingAvailabilityConfiguration: async () => ({
      requiredResourceIds: ["resource-provider", "resource-room"],
      resources: [
        {
          busyCalendarAssignments: [
            {
              calendarId: "provider-calendar@example.com",
              connectionId: "connection-provider",
              id: "assignment-provider",
            },
          ],
          exceptions: [],
          recurringWindows: [
            {
              effectiveFrom: "2030-01-01",
              endsAt: "17:00",
              isoWeekday: 1,
              startsAt: "09:00",
              timezone: "UTC",
            },
          ],
          resourceId: "resource-provider",
          timezone: "UTC",
        },
        {
          busyCalendarAssignments: [
            {
              calendarId: "secondary-calendar@example.com",
              connectionId: "connection-secondary",
              id: "assignment-secondary",
            },
          ],
          exceptions: [],
          recurringWindows: [
            {
              effectiveFrom: "2030-01-01",
              endsAt: "16:00",
              isoWeekday: 1,
              startsAt: "10:00",
              timezone: "UTC",
            },
          ],
          resourceId: "resource-room",
          timezone: "UTC",
        },
      ],
    }),
    listConnectionCalendarEvents: async () => [],
    listReservationBusyWindows: async ({ resourceId }) =>
      resourceId === "resource-provider"
        ? [
            {
              end: new Date("2030-06-03T15:00:00.000Z"),
              id: "reservation-1",
              start: new Date("2030-06-03T14:00:00.000Z"),
            },
          ]
        : [],
    ...overrides,
  };
}

function createOffering(): OperationalBookingOffering {
  return {
    addOns: [
      {
        description: "Extended lash bath",
        durationDeltaMinutes: 30,
        key: "lash-bath",
        name: "Lash bath",
        priceCents: 1500,
        status: "active",
      },
    ],
    bookingType: "in-person-appointment",
    bufferAfterMinutes: 15,
    bufferBeforeMinutes: 15,
    calendar: {
      assignmentId: "assignment-provider",
      calendarId: "provider-calendar@example.com",
      connectionId: "connection-provider",
    },
    currency: "CAD",
    depositAmountCents: 5000,
    durationMinutes: 60,
    fullPriceCents: 15000,
    horizonDays: 1,
    id: "00000000-0000-4000-8000-000000000001",
    minimumLeadTimeHours: 0,
    offeringKey: "classic-fill-nataliea",
    provider: {
      displayName: "Nataliea",
      id: "provider-1",
      providerKey: "nataliea",
      publicSlug: "nataliea",
      status: "active",
    },
    resource: {
      id: "resource-provider",
      name: "Nataliea",
      resourceKey: "provider-nataliea",
      status: "active",
      timezone: "UTC",
    },
    service: {
      displayTitle: "Classic Fill",
      id: "service-1",
      publicSlug: "classic-fill",
      serviceKey: "classic-fill",
      status: "active",
    },
    slotIntervalMinutes: 30,
    status: "active",
    version: 1,
  };
}
