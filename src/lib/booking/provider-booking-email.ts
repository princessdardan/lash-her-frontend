import "server-only";

import { createHash } from "node:crypto";

import {
  claimProviderBookingEmail,
  markProviderBookingEmailSent,
  recordProviderBookingEmailFailure,
  type ProviderBookingEmailClaim,
  type ProviderBookingEmailLookup,
} from "@/lib/private-db/booking-provider-email-repository";
import type { CheckoutOrderPurpose } from "@/lib/private-db/schema";
import { getConfiguredTransactionalTemplate } from "@/lib/resend-platform";
import { calculateServiceBookingHstQuote } from "@/lib/booking/service-tax-policy";
import { readServicePromotionSnapshot } from "@/lib/booking/payments/service-promotion";
import {
  CUSTOMER_REPLY_TO_EMAIL,
  escapeHtml,
  getEmailConfig,
  getEmailProfileImageHtml,
  sendTransactionalEmail,
} from "@/lib/transactional-email";

export interface SendProviderBookingEmailInput {
  addOnPaymentCopy: string | null;
  bookedSubtotalCents: number;
  bookedTotalAfterTaxCents: number;
  bookingPaymentAmountCents: number;
  currency: string;
  customerEmail: string;
  customerName: string;
  customerPhone: string;
  end: Date;
  holdId: string;
  orderId: string;
  paymentKindLabel: string;
  paymentProvider: string;
  providerName: string;
  recipientEmails: string[];
  remainingBalanceAfterTaxCents: number;
  remainingBalanceCents: number;
  serviceName: string;
  start: Date;
  timezone: string;
  tipAmountCents: number;
  totalPaidCents: number;
}

export interface ProviderBookingEmailDependencies {
  claimProviderBookingEmail: typeof claimProviderBookingEmail;
  logError: typeof console.error;
  markProviderBookingEmailSent: typeof markProviderBookingEmailSent;
  recordProviderBookingEmailFailure: typeof recordProviderBookingEmailFailure;
  sendProviderBookingEmail: typeof sendProviderBookingEmail;
}

export const PROVIDER_BOOKING_EMAIL_SUBJECT_PREFIX = "New booking confirmed";

export async function sendProviderBookingEmail(
  input: SendProviderBookingEmailInput,
): Promise<void> {
  const recipients =
    input.recipientEmails.length > 0
      ? [...new Set(input.recipientEmails)]
      : [getEmailConfig().adminEmail];
  const formattedStart = formatBookingDateTime(input.start, input.timezone);
  const formattedEnd = formatBookingDateTime(input.end, input.timezone);
  const templateVariables = getProviderBookingTemplateVariables({
    ...input,
    formattedEnd,
    formattedStart,
  });

  await Promise.all(
    recipients.map((recipient) =>
      sendTransactionalEmail({
        html: getProviderBookingHtml({
          ...input,
          formattedEnd,
          formattedStart,
        }),
        idempotencyKey: getProviderBookingEmailIdempotencyKey(
          input.holdId,
          recipient,
        ),
        replyTo: CUSTOMER_REPLY_TO_EMAIL,
        subject: `${PROVIDER_BOOKING_EMAIL_SUBJECT_PREFIX}: ${input.serviceName}`,
        tags: [
          { name: "flow", value: "provider_booking_confirmation" },
          { name: "order_id", value: input.orderId },
          { name: "payment_provider", value: input.paymentProvider },
        ],
        template: getConfiguredTransactionalTemplate(
          "provider_booking_confirmation",
          templateVariables,
        ),
        to: recipient,
      }),
    ),
  );
}

export async function sendProviderBookingEmailForOrder(
  orderId: string,
  dependencies: ProviderBookingEmailDependencies = defaultDependencies,
): Promise<void> {
  await sendProviderBookingEmailForLookup({ orderId }, dependencies);
}

export async function sendProviderBookingEmailForHold(
  holdId: string,
  dependencies: ProviderBookingEmailDependencies = defaultDependencies,
): Promise<void> {
  await sendProviderBookingEmailForLookup({ holdId }, dependencies);
}

export async function sendProviderBookingEmailForPublicReference(
  publicReference: string,
  dependencies: ProviderBookingEmailDependencies = defaultDependencies,
): Promise<void> {
  await sendProviderBookingEmailForLookup({ publicReference }, dependencies);
}

export function buildProviderBookingFallbackHtml(
  input: SendProviderBookingEmailInput,
): string {
  return getProviderBookingHtml({
    ...input,
    formattedEnd: formatBookingDateTime(input.end, input.timezone),
    formattedStart: formatBookingDateTime(input.start, input.timezone),
  });
}

export function getProviderBookingSeedTemplateVariables(
  input: SendProviderBookingEmailInput,
): Record<string, unknown> {
  return getProviderBookingTemplateVariables({
    ...input,
    formattedEnd: formatBookingDateTime(input.end, input.timezone),
    formattedStart: formatBookingDateTime(input.start, input.timezone),
  });
}

export function getProviderBookingEmailIdempotencyKey(
  holdId: string,
  recipientEmail: string,
): string {
  const recipientHash = createHash("sha256")
    .update(recipientEmail.trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return `provider-booking-confirmation:${holdId}:${recipientHash}`;
}

export function toProviderBookingEmailInput(
  claim: ProviderBookingEmailClaim,
): SendProviderBookingEmailInput {
  const selectedAddOn = readSelectedAddOn(claim.offeringSnapshot);
  const paymentPurpose =
    toAppointmentPaymentPurpose(claim.paymentPurpose) ??
    readSelectedPaymentPurpose(claim.offeringSnapshot);
  const serviceName =
    readNonEmptyString(claim.offeringSnapshot.title) ?? "Lash appointment";
  const tipAmountCents = Math.max(0, claim.tipAmountCents);
  const bookingPaymentAmountCents = Math.max(0, claim.capturedAmountCents);
  const pricingSummary = getProviderBookingPricingSummary(
    claim.offeringSnapshot,
  );

  return {
    addOnPaymentCopy:
      selectedAddOn === null
        ? null
        : `${selectedAddOn.name} selected (${formatMoney(selectedAddOn.priceCents, selectedAddOn.currency)}); included in the booked totals shown in the payment section.`,
    bookedSubtotalCents: pricingSummary.bookedSubtotalCents,
    bookedTotalAfterTaxCents: pricingSummary.bookedTotalAfterTaxCents,
    bookingPaymentAmountCents,
    currency: claim.currency,
    customerEmail: claim.customer.email,
    customerName: claim.customer.name,
    customerPhone: claim.customer.phone,
    end: claim.end,
    holdId: claim.holdId,
    orderId: claim.orderId,
    paymentKindLabel: getPaymentKindLabel(paymentPurpose),
    paymentProvider: claim.paymentProvider,
    providerName: claim.providerName,
    recipientEmails: claim.recipientEmails,
    remainingBalanceAfterTaxCents: pricingSummary.remainingBalanceAfterTaxCents,
    remainingBalanceCents: pricingSummary.remainingBalanceCents,
    serviceName,
    start: claim.start,
    timezone: claim.timezone,
    tipAmountCents,
    totalPaidCents: bookingPaymentAmountCents + tipAmountCents,
  };
}

async function sendProviderBookingEmailForLookup(
  lookup: ProviderBookingEmailLookup,
  dependencies: ProviderBookingEmailDependencies,
): Promise<void> {
  const claimed = await dependencies.claimProviderBookingEmail({ lookup });
  if (claimed === null) {
    return;
  }

  try {
    await dependencies.sendProviderBookingEmail(
      toProviderBookingEmailInput(claimed),
    );
    await dependencies.markProviderBookingEmailSent({ holdId: claimed.holdId });
  } catch (error) {
    const message = getErrorMessage(error);
    await dependencies.recordProviderBookingEmailFailure({
      error: message,
      holdId: claimed.holdId,
    });
    dependencies.logError("[booking-email] Provider booking email failed", {
      error: message,
      holdId: claimed.holdId,
      orderId: claimed.orderId,
    });
    throw new Error(message, { cause: error });
  }
}

const defaultDependencies: ProviderBookingEmailDependencies = {
  claimProviderBookingEmail,
  logError: console.error,
  markProviderBookingEmailSent,
  recordProviderBookingEmailFailure,
  sendProviderBookingEmail,
};

interface ProviderBookingHtmlInput extends SendProviderBookingEmailInput {
  formattedEnd: string;
  formattedStart: string;
}

function getProviderBookingHtml(input: ProviderBookingHtmlInput): string {
  const bookedSubtotal = formatMoney(input.bookedSubtotalCents, input.currency);
  const bookedTotalAfterTax = formatMoney(
    input.bookedTotalAfterTaxCents,
    input.currency,
  );
  const bookingPayment = formatMoney(
    input.bookingPaymentAmountCents,
    input.currency,
  );
  const remainingBalance = formatMoney(
    input.remainingBalanceCents,
    input.currency,
  );
  const remainingBalanceAfterTax = formatMoney(
    input.remainingBalanceAfterTaxCents,
    input.currency,
  );
  const tip = formatMoney(input.tipAmountCents, input.currency);
  const totalPaid = formatMoney(input.totalPaidCents, input.currency);

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New booking confirmed</title>
</head>
<body style="margin:0;padding:0;background-color:#F5F1F5;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1C1318;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" style="width:100%;max-width:640px;border-collapse:collapse;background-color:#FFFFFF;border:1px solid #E8E2E9;">
          <tr>
            <td style="padding:34px 32px;text-align:center;background-color:#1C1318;color:#FFFFFF;">
              ${getEmailProfileImageHtml()}
              <p style="margin:0 0 10px 0;font-size:12px;letter-spacing:0.22em;text-transform:uppercase;">Lash Her by Nataliea</p>
              <h1 style="margin:0;font-family:'Bebas Neue','Arial Narrow',Impact,sans-serif;letter-spacing:0.04em;text-transform:uppercase;font-size:30px;font-weight:500;line-height:1.2;">New booking confirmed</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:34px 32px;">
              <p style="margin:0 0 20px 0;font-size:16px;line-height:1.7;">Hi ${escapeHtml(input.providerName)},</p>
              <p style="margin:0 0 24px 0;font-size:15px;line-height:1.7;">A client booking was successfully created. The confirmed booking and captured payment details are below.</p>

              ${getDetailsSectionHtml("Appointment", [
                ["Service", input.serviceName],
                ["Starts", input.formattedStart],
                ["Ends", input.formattedEnd],
                ["Timezone", input.timezone],
              ])}

              ${getDetailsSectionHtml("Client", [
                ["Name", input.customerName],
                ["Email", input.customerEmail],
                ["Phone", input.customerPhone],
              ])}

              ${getDetailsSectionHtml("Payment", [
                ["Payment type", input.paymentKindLabel],
                ["Booked subtotal (service + add-on)", bookedSubtotal],
                ["Booked total after HST", bookedTotalAfterTax],
                ["Booking payment captured", bookingPayment],
                ["Tip", tip],
                ["Total paid at booking", totalPaid],
                ["Remaining balance before HST", remainingBalance],
                ["Remaining balance after HST", remainingBalanceAfterTax],
                ["Payment provider", input.paymentProvider],
                ["Booking reference", input.orderId],
              ])}

              ${getProviderAddOnHtml(input.addOnPaymentCopy)}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

function getProviderBookingTemplateVariables(
  input: ProviderBookingHtmlInput,
): Record<string, unknown> {
  return {
    ADD_ON_PAYMENT_COPY: escapeHtml(input.addOnPaymentCopy ?? "None"),
    BOOKED_SUBTOTAL: formatMoney(input.bookedSubtotalCents, input.currency),
    BOOKED_TOTAL_AFTER_TAX: formatMoney(
      input.bookedTotalAfterTaxCents,
      input.currency,
    ),
    BOOKING_PAYMENT_AMOUNT: formatMoney(
      input.bookingPaymentAmountCents,
      input.currency,
    ),
    CUSTOMER_EMAIL: escapeHtml(input.customerEmail),
    CUSTOMER_NAME: escapeHtml(input.customerName),
    CUSTOMER_PHONE: escapeHtml(input.customerPhone),
    FORMATTED_END: escapeHtml(input.formattedEnd),
    FORMATTED_START: escapeHtml(input.formattedStart),
    HOLD_ID: escapeHtml(input.holdId),
    ORDER_ID: escapeHtml(input.orderId),
    PAYMENT_KIND: escapeHtml(input.paymentKindLabel),
    PAYMENT_PROVIDER: escapeHtml(input.paymentProvider),
    PROVIDER_NAME: escapeHtml(input.providerName),
    REMAINING_BALANCE: formatMoney(input.remainingBalanceCents, input.currency),
    REMAINING_BALANCE_AFTER_TAX: formatMoney(
      input.remainingBalanceAfterTaxCents,
      input.currency,
    ),
    SERVICE_NAME: escapeHtml(input.serviceName),
    TIMEZONE: escapeHtml(input.timezone),
    TIP_AMOUNT: formatMoney(input.tipAmountCents, input.currency),
    TOTAL_PAID: formatMoney(input.totalPaidCents, input.currency),
  };
}

function getDetailsSectionHtml(
  heading: string,
  rows: Array<[label: string, value: string]>,
): string {
  return `
<h2 style="margin:26px 0 10px 0;font-size:15px;letter-spacing:0.08em;text-transform:uppercase;">${escapeHtml(heading)}</h2>
<table role="presentation" style="width:100%;border-collapse:collapse;background-color:#F5F1F5;">
  ${rows
    .map(
      ([label, value]) => `
  <tr>
    <td style="width:42%;padding:9px 12px;border-bottom:1px solid #E8E2E9;font-size:13px;font-weight:600;vertical-align:top;">${escapeHtml(label)}</td>
    <td style="padding:9px 12px;border-bottom:1px solid #E8E2E9;font-size:13px;line-height:1.5;vertical-align:top;">${escapeHtml(value)}</td>
  </tr>`,
    )
    .join("")}
</table>`;
}

function getProviderAddOnHtml(copy: string | null): string {
  return copy === null
    ? ""
    : `<p style="margin:22px 0 0 0;padding:16px;border-left:4px solid #D4B483;background-color:#F5F1F5;font-size:14px;line-height:1.6;"><strong>Add-on:</strong> ${escapeHtml(copy)}</p>`;
}

function getPaymentKindLabel(
  purpose: AppointmentPaymentPurpose | null,
): string {
  switch (purpose) {
    case "appointment_deposit":
      return "Deposit";
    case "appointment_full":
      return "Full payment";
    case "appointment_custom_partial":
      return "Custom partial payment";
    default:
      return "Booking payment";
  }
}

type AppointmentPaymentPurpose = Extract<
  CheckoutOrderPurpose,
  "appointment_deposit" | "appointment_full" | "appointment_custom_partial"
>;

function toAppointmentPaymentPurpose(
  purpose: CheckoutOrderPurpose | null,
): AppointmentPaymentPurpose | null {
  return purpose === "appointment_deposit" ||
    purpose === "appointment_full" ||
    purpose === "appointment_custom_partial"
    ? purpose
    : null;
}

function readSelectedPaymentPurpose(
  snapshot: Record<string, unknown>,
): AppointmentPaymentPurpose | null {
  const selectedPayment = snapshot.selectedPayment;
  if (!isRecord(selectedPayment)) {
    return null;
  }

  return toAppointmentPaymentPurpose(
    typeof selectedPayment.purpose === "string"
      ? (selectedPayment.purpose as CheckoutOrderPurpose)
      : null,
  );
}

function readSelectedAddOn(
  snapshot: Record<string, unknown>,
): { currency: string; name: string; priceCents: number } | null {
  const addOn = snapshot.selectedAddOn;
  if (!isRecord(addOn)) {
    return null;
  }

  const name = readNonEmptyString(addOn.name);
  const currency = readNonEmptyString(addOn.currency) ?? "CAD";
  const price = addOn.price;
  if (name === null || typeof price !== "number" || !Number.isFinite(price)) {
    return null;
  }

  return { currency, name, priceCents: Math.round(price * 100) };
}

interface ProviderBookingPricingSummary {
  bookedSubtotalCents: number;
  bookedTotalAfterTaxCents: number;
  remainingBalanceAfterTaxCents: number;
  remainingBalanceCents: number;
}

function getProviderBookingPricingSummary(
  snapshot: Record<string, unknown>,
): ProviderBookingPricingSummary {
  const pricing = isRecord(snapshot.pricing) ? snapshot.pricing : snapshot;
  const fullPriceCents = dollarsToPositiveCents(pricing.fullPrice);
  const selectedPaymentCents = readSelectedPaymentAmountCents(snapshot);
  const selectedAddOn = readSelectedAddOn(snapshot);

  if (fullPriceCents === null || selectedPaymentCents === null) {
    return {
      bookedSubtotalCents: 0,
      bookedTotalAfterTaxCents: 0,
      remainingBalanceAfterTaxCents: 0,
      remainingBalanceCents: 0,
    };
  }

  const promotion = readServicePromotionSnapshot(snapshot, fullPriceCents);
  const servicePriceCents =
    promotion?.discountedBasePriceCents ?? fullPriceCents;
  const bookedSubtotalCents =
    servicePriceCents + (selectedAddOn?.priceCents ?? 0);
  const remainingBalanceCents = Math.max(
    0,
    bookedSubtotalCents - selectedPaymentCents,
  );

  return {
    bookedSubtotalCents,
    bookedTotalAfterTaxCents: addServiceHst(bookedSubtotalCents),
    remainingBalanceAfterTaxCents: addServiceHst(remainingBalanceCents),
    remainingBalanceCents,
  };
}

function readSelectedPaymentAmountCents(
  snapshot: Record<string, unknown>,
): number | null {
  const selectedPayment = snapshot.selectedPayment;
  if (!isRecord(selectedPayment)) {
    return null;
  }

  if (
    typeof selectedPayment.amountCents === "number" &&
    Number.isSafeInteger(selectedPayment.amountCents) &&
    selectedPayment.amountCents > 0
  ) {
    return selectedPayment.amountCents;
  }

  return dollarsToPositiveCents(selectedPayment.amount);
}

function dollarsToPositiveCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function addServiceHst(amountCents: number): number {
  return amountCents === 0
    ? 0
    : calculateServiceBookingHstQuote(amountCents).expectedAmountCents;
}

function formatBookingDateTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: timezone,
  }).format(date);
}

function formatMoney(amountCents: number, currency: string): string {
  return new Intl.NumberFormat("en-CA", {
    currency: currency.toUpperCase(),
    style: "currency",
  }).format(amountCents / 100);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown email error";
}
