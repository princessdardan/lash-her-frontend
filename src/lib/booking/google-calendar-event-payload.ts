import type { calendar_v3 } from "googleapis";
import type { PaymentProvider } from "@/lib/private-db/schema";

export const BOOKING_EVENT_HOLD_PROPERTY = "lashHerBookingHoldId";

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
  checkoutOrderId?: string;
  checkoutOrderPublicId?: string;
  holdId: string;
  paymentProvider?: PaymentProvider;
}

export interface BookingEventPayloadInput {
  bookingMetadata?: BookingEventMetadataInput;
  bookingTypeLabel: string;
  customer: BookingEventCustomerInput;
  answers: BookingEventAnswerInput[];
  start: Date;
  end: Date;
  timezone: string;
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


  descriptionParts.push(
    "",
    "Changes: Please contact Lash Her to request booking changes.",
  );

  return {
    extendedProperties: input.bookingMetadata
      ? { private: toPrivateBookingMetadata(input.bookingMetadata) }
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

function toPrivateBookingMetadata(input: BookingEventMetadataInput): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      [BOOKING_EVENT_HOLD_PROPERTY]: input.holdId,
      lashHerCheckoutOrderId: input.checkoutOrderId,
      lashHerCheckoutOrderPublicId: input.checkoutOrderPublicId,
      lashHerPaymentProvider: input.paymentProvider,
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
  );
}
