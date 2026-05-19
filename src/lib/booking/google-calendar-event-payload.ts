import type { calendar_v3 } from "googleapis";
import type { PaidTrainingBookingContext } from "./types";

interface BookingEventAnswerInput {
  questionLabel: string;
  answer: string;
}

interface BookingEventCustomerInput {
  name: string;
  email: string;
  phone: string;
}

export interface BookingEventMetadataInput {
  holdId: string;
}

export interface BookingEventPayloadInput {
  bookingMetadata?: BookingEventMetadataInput;
  bookingTypeLabel: string;
  customer: BookingEventCustomerInput;
  answers: BookingEventAnswerInput[];
  start: Date;
  end: Date;
  timezone: string;
  paidTrainingContext?: PaidTrainingBookingContext;
}

export function buildBookingEventPayload(
  input: BookingEventPayloadInput,
): calendar_v3.Schema$Event {
  const answersText = input.answers
    .map((answer) => `${answer.questionLabel}: ${answer.answer}`)
    .join("\n");
  const descriptionParts = [
    `Customer: ${input.customer.name}`,
    `Email: ${input.customer.email}`,
    `Phone: ${input.customer.phone}`,
    "",
    "Answers:",
    answersText.length > 0 ? answersText : "No answers provided",
  ];

  if (input.paidTrainingContext !== undefined) {
    descriptionParts.push(
      "",
      "Paid training context:",
      `Program: ${input.paidTrainingContext.programTitle}`,
      `Order: ${input.paidTrainingContext.publicOrderId}`,
    );
  }

  descriptionParts.push(
    "",
    "Changes: Please contact Lash Her to request booking changes.",
  );

  return {
    extendedProperties: input.bookingMetadata
      ? {
          private: {
            lashHerBookingHoldId: input.bookingMetadata.holdId,
          },
        }
      : undefined,
    summary: `Lash Her booking: ${input.bookingTypeLabel} — ${input.customer.name}`,
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
        email: input.customer.email,
        displayName: input.customer.name,
      },
    ],
    reminders: {
      useDefault: true,
    },
  };
}
