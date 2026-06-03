import type { calendar_v3 } from "googleapis";
import type { PaymentProvider } from "@/lib/private-db/schema";
import { getBookingPaymentSelection, getBookingSelectedAddOn } from "@/lib/booking/payment-policy";
import type { BookingHoldRecord } from "./holds";

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
  hold?: BookingHoldRecord;
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
  const addOnPaymentCopy = input.hold ? getBookingAddOnPaymentCopy(input.hold) : null;

  if (addOnPaymentCopy !== null) {
    descriptionParts.push("", addOnPaymentCopy);
  }


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

function getBookingAddOnPaymentCopy(hold: BookingHoldRecord): string | null {
  const selectedAddOn = getBookingSelectedAddOn(hold);
  const paymentSelection = getBookingPaymentSelection(hold);

  return selectedAddOn
    ? paymentSelection?.purpose === "appointment_full"
      ? `${selectedAddOn.name} add-on included in payment.`
      : `${selectedAddOn.name} add-on balance is due later (${formatCad(selectedAddOn.price)}).`
    : null;
}

function formatCad(amount: number): string {
  return new Intl.NumberFormat("en-CA", {
    currency: "CAD",
    style: "currency",
  }).format(amount);
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
