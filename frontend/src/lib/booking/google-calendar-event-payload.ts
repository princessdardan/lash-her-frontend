import type { calendar_v3 } from "googleapis";

interface BookingEventAnswerInput {
  question: string;
  answer: string;
}

export interface BookingEventPayloadInput {
  bookingTypeLabel: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  answers: BookingEventAnswerInput[];
  start: Date;
  end: Date;
  timezone: string;
}

export function buildBookingEventPayload(
  input: BookingEventPayloadInput,
): calendar_v3.Schema$Event {
  const answersText = input.answers
    .map((answer) => `${answer.question}: ${answer.answer}`)
    .join("\n");
  const descriptionParts = [
    `Customer: ${input.customerName}`,
    `Email: ${input.customerEmail}`,
    `Phone: ${input.customerPhone}`,
    "",
    "Answers:",
    answersText.length > 0 ? answersText : "No answers provided",
    "",
    "Changes: Please contact Lash Her to request booking changes.",
  ];

  return {
    summary: `Lash Her booking: ${input.bookingTypeLabel} — ${input.customerName}`,
    description: descriptionParts.join("\n"),
    start: {
      dateTime: input.start.toISOString(),
      timeZone: input.timezone,
    },
    end: {
      dateTime: input.end.toISOString(),
      timeZone: input.timezone,
    },
    attendees: [
      {
        email: input.customerEmail,
        displayName: input.customerName,
      },
    ],
    reminders: {
      useDefault: false,
      overrides: [
        { method: "email", minutes: 24 * 60 },
        { method: "popup", minutes: 30 },
      ],
    },
  };
}
