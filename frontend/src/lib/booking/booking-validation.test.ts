import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findBookingTypeConfig,
  validateBookingRequest,
} from "./booking-validation";
import type { BookingRequestInput, BookingSettings } from "./types";

const settings: BookingSettings = {
  calendarId: "primary",
  availabilityMarkerTitle: "Available for booking",
  bookingHorizonDays: 30,
  minimumLeadTimeHours: 24,
  timezone: "America/Toronto",
  marketingOptInLabel: "Send me booking updates",
  bookingTypes: [
    {
      type: "training-call",
      label: "Training sign-up call",
      description: "A quick call to discuss training goals.",
      durationMinutes: 30,
      slotIntervalMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      questions: [
        {
          id: "goal",
          label: "What is your training goal?",
          inputType: "textarea",
          required: true,
        },
      ],
    },
  ],
};

const validRequest: BookingRequestInput = {
  bookingType: "training-call",
  start: "2026-05-12T14:00:00.000Z",
  name: "Natalie Smith",
  email: "natalie@example.com",
  phone: "555-555-5555",
  answers: [{ questionId: "goal", answer: "Build confidence with classic sets." }],
  marketingOptIn: true,
  idempotencyKey: "booking-request-1",
};

test("findBookingTypeConfig returns the requested booking type config", () => {
  assert.equal(
    findBookingTypeConfig(settings, "training-call").label,
    "Training sign-up call",
  );
});

test("validateBookingRequest rejects missing required dynamic answers", () => {
  const result = validateBookingRequest(settings, {
    ...validRequest,
    answers: [],
  });

  assert.equal(result.success, false);

  if (!result.success) {
    assert.deepEqual(result.fieldErrors, {
      "answers.goal": "What is your training goal? is required",
    });
  }
});
