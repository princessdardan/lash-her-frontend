import assert from "node:assert/strict";
import test from "node:test";

import {
  getAdminAppointmentAttentionReasons,
  getAdminAppointmentEmailPresentation,
  getAdminAppointmentEventLabel,
  toAdminAppointmentSnapshotPresentation,
} from "./appointment-presentation";

test("appointment snapshot presentation keeps only explicitly allowed customer-facing fields", () => {
  const result = toAdminAppointmentSnapshotPresentation({
    intake: {
      answers: [
        {
          answer: "No known allergies",
          questionId: "internal-allergy-question",
          questionLabel: "Allergies",
          squareTeamMemberId: "team-intake",
        },
      ],
      intakeConfigurationVersion: 17,
    },
    offering: {
      configurationVersion: 42,
      durationMinutes: 105,
      offeringId: "offering-id",
      operationalPricing: {
        depositAmountCents: 5_000,
        fullPriceCents: 12_000,
      },
      reservedResourceIds: ["resource-id"],
      selectedAddOn: {
        description: "A gentle cleansing treatment.",
        key: "lash-bath",
        name: "Lash bath",
        price: 25,
      },
      service: {
        displayTitle: "Classic full set",
        sanityDocumentId: "cms-id",
        serviceId: "service-id",
        serviceKey: "classic",
      },
    },
    provider: {
      displayName: "Ava",
      providerId: "provider-id",
      providerKey: "ava",
      squareTeamMemberId: "team-provider",
    },
  });

  assert.deepEqual(result, {
    addOn: {
      description: "A gentle cleansing treatment.",
      name: "Lash bath",
    },
    durationMinutes: 105,
    intake: [{ answer: "No known allergies", label: "Allergies" }],
    providerName: "Ava",
    serviceName: "Classic full set",
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(
    serialized,
    /configuration|questionId|providerId|providerKey|resource|sanity|square|price/i,
  );
});

test("appointment snapshot presentation hides question identifiers and ignores malformed future fields", () => {
  const result = toAdminAppointmentSnapshotPresentation({
    intake: {
      answers: [
        { answer: "Sensitive eyes", questionId: "sensitivity-internal-id" },
        { answer: "", questionLabel: "Empty" },
        { answer: 17, questionLabel: "Wrong type" },
      ],
      futurePrivatePayload: { secret: "do-not-render" },
    },
    offering: {
      durationMinutes: -1,
      futurePricingStructure: { internal: true },
      title: "Legacy lash appointment",
    },
    provider: { internalId: "provider-1" },
  });

  assert.deepEqual(result, {
    addOn: null,
    durationMinutes: null,
    intake: [{ answer: "Sensitive eyes", label: "Intake response 1" }],
    providerName: null,
    serviceName: "Legacy lash appointment",
  });
  assert.doesNotMatch(JSON.stringify(result), /sensitivity-internal-id|secret/);
});

test("attention reasons include only states that require staff action", () => {
  const now = new Date("2026-07-29T18:00:00.000Z");

  assert.deepEqual(
    getAdminAppointmentAttentionReasons({
      bookingConfirmationEmailFailed: true,
      calendarSyncStatus: "manual_followup",
      now,
      paymentStatus: "refund_required",
      selectedEnd: new Date("2026-07-29T17:00:00.000Z"),
      status: "confirmed",
    }),
    [
      "Refund review is required",
      "Calendar sync needs attention",
      "Attendance has not been recorded",
      "Confirmation email delivery failed",
    ],
  );

  assert.deepEqual(
    getAdminAppointmentAttentionReasons({
      bookingConfirmationEmailFailed: false,
      calendarSyncStatus: "retryable_failed",
      now,
      paymentStatus: "paid",
      selectedEnd: new Date("2026-07-29T19:00:00.000Z"),
      status: "confirmed",
    }),
    [],
  );
});

test("email and activity presentation never expose raw error or event values", () => {
  assert.deepEqual(
    getAdminAppointmentEmailPresentation({
      lastError: "provider-secret-error",
      sentAt: null,
    }),
    { label: "Delivery needs attention", tone: "attention" },
  );
  assert.equal(
    getAdminAppointmentEventLabel("calendar_manual_followup"),
    "Calendar follow-up requested",
  );
  assert.equal(
    getAdminAppointmentEventLabel("future_internal_event_with_ids"),
    "Appointment updated",
  );
});
