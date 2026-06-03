import "server-only";

import {
  claimBookingConfirmationEmailByOrderId,
  markBookingConfirmationEmailSent,
  recordBookingConfirmationEmailFailure,
  type BookingConfirmationEmailClaimRecord,
} from "./holds";
import { getBookingPaymentSelection, getBookingSelectedAddOn } from "@/lib/booking/payment-policy";
import { getConfiguredTransactionalTemplate } from "@/lib/resend-platform";
import { CUSTOMER_REPLY_TO_EMAIL, escapeHtml, getEmailProfileImageHtml, sendTransactionalEmail } from "@/lib/transactional-email";

export interface SendBookingConfirmationInput {
  addOnPaymentCopy?: string | null;
  bookingTypeLabel: string;
  email: string;
  holdId: string;
  name: string;
  orderId: string;
  paymentProvider: string;
  start: Date;
  timezone: string;
}

export interface SendBookingConfirmationEmailForOrderDependencies {
  claimBookingConfirmationEmailByOrderId: typeof claimBookingConfirmationEmailByOrderId;
  logError: typeof console.error;
  markBookingConfirmationEmailSent: typeof markBookingConfirmationEmailSent;
  recordBookingConfirmationEmailFailure: typeof recordBookingConfirmationEmailFailure;
  sendBookingConfirmationEmail: typeof sendBookingConfirmationEmail;
}

export const BOOKING_CONFIRMATION_EMAIL_SUBJECT = "Your Lash Her booking is confirmed";

export async function sendBookingConfirmationEmail(
  input: SendBookingConfirmationInput,
): Promise<void> {
  const formattedStart = new Intl.DateTimeFormat("en-CA", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: input.timezone,
  }).format(input.start);

  await sendTransactionalEmail({
    html: getBookingConfirmationHtml({ ...input, formattedStart }),
    idempotencyKey: `booking-confirmation:${input.holdId}`,
    replyTo: CUSTOMER_REPLY_TO_EMAIL,
    subject: BOOKING_CONFIRMATION_EMAIL_SUBJECT,
    tags: [
      { name: "flow", value: "booking_confirmation" },
      { name: "order_id", value: input.orderId },
      { name: "payment_provider", value: input.paymentProvider },
    ],
    template: getConfiguredTransactionalTemplate(
      "booking_confirmation",
      getBookingConfirmationTemplateVariables({ ...input, formattedStart }),
    ),
    to: input.email,
  });
}

export function buildBookingConfirmationFallbackHtml(input: SendBookingConfirmationInput): string {
  return getBookingConfirmationHtml({
    ...input,
    formattedStart: formatBookingConfirmationStart(input.start, input.timezone),
  });
}

export function getBookingConfirmationSeedTemplateVariables(input: SendBookingConfirmationInput): Record<string, unknown> {
  const formattedStart = formatBookingConfirmationStart(input.start, input.timezone);

  return getBookingConfirmationTemplateVariables({ ...input, formattedStart });
}

export async function sendBookingConfirmationEmailForOrder(
  orderId: string,
  dependencies: SendBookingConfirmationEmailForOrderDependencies = defaultSendBookingConfirmationEmailForOrderDependencies,
): Promise<void> {
  const claimed = await dependencies.claimBookingConfirmationEmailByOrderId({ orderId });

  if (claimed === null) {
    return;
  }

  try {
    await dependencies.sendBookingConfirmationEmail(toBookingConfirmationInput(claimed, orderId));
    await dependencies.markBookingConfirmationEmailSent({ holdId: claimed.id });
  } catch (error) {
    const message = getErrorMessage(error);
    await dependencies.recordBookingConfirmationEmailFailure({
      error: message,
      holdId: claimed.id,
    });
    dependencies.logError("[booking-email] Booking confirmation email failed", {
      error: message,
      holdId: claimed.id,
      orderId,
    });
    throw new Error(message, { cause: error });
  }
}

const defaultSendBookingConfirmationEmailForOrderDependencies: SendBookingConfirmationEmailForOrderDependencies = {
  claimBookingConfirmationEmailByOrderId,
  logError: console.error,
  markBookingConfirmationEmailSent,
  recordBookingConfirmationEmailFailure,
  sendBookingConfirmationEmail,
};

interface BookingConfirmationHtmlInput extends SendBookingConfirmationInput {
  formattedStart: string;
}

function getBookingConfirmationHtml(input: BookingConfirmationHtmlInput): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Lash Her booking is confirmed</title>
</head>
<body style="margin:0;padding:0;background-color:#F5F1F5;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1C1318;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" style="width:100%;max-width:600px;border-collapse:collapse;background-color:#FFFFFF;border:1px solid #E8E2E9;">
          <tr>
            <td style="padding:34px 32px;text-align:center;background-color:#1C1318;color:#FFFFFF;">
              ${getEmailProfileImageHtml()}
              <p style="margin:0 0 10px 0;font-size:12px;letter-spacing:0.22em;text-transform:uppercase;">Lash Her by Nataliea</p>
              <h1 style="margin:0;font-family:'Bebas Neue','Arial Narrow',Impact,sans-serif;letter-spacing:0.04em;text-transform:uppercase;font-size:30px;font-weight:500;line-height:1.2;">Your booking is confirmed</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:34px 32px;">
              <p style="margin:0 0 18px 0;font-size:16px;line-height:1.7;">Hi ${escapeHtml(input.name)},</p>
              <p style="margin:0 0 22px 0;font-size:15px;line-height:1.7;">Your ${escapeHtml(input.bookingTypeLabel)} with Lash Her is reserved for <strong>${escapeHtml(input.formattedStart)}</strong>.</p>
              ${input.addOnPaymentCopy ? `<p style="margin:0 0 22px 0;font-size:15px;line-height:1.7;">${escapeHtml(input.addOnPaymentCopy)}</p>` : ""}
              <div style="margin:28px 0;padding:20px;border-left:4px solid #D4B483;background-color:#F5F1F5;">
                <p style="margin:0;font-size:14px;line-height:1.7;">If you need to make a change, please contact Lash Her directly so we can help adjust your appointment.</p>
              </div>
              <p style="margin:0;font-size:15px;line-height:1.7;">We look forward to connecting with you.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px;text-align:center;background-color:#1C1318;color:#F5F1F5;">
              <p style="margin:0;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;">Bespoke luxury lash artistry</p>
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

function getBookingConfirmationTemplateVariables(input: BookingConfirmationHtmlInput): Record<string, unknown> {
  return {
    ADD_ON_PAYMENT_COPY: escapeHtml(input.addOnPaymentCopy ?? ""),
    BOOKING_TYPE_LABEL: escapeHtml(input.bookingTypeLabel),
    CUSTOMER_EMAIL: escapeHtml(input.email),
    CUSTOMER_FIRST_NAME: escapeHtml(input.name.trim().split(/\s+/)[0] ?? ""),
    CUSTOMER_NAME: escapeHtml(input.name),
    FORMATTED_START: escapeHtml(input.formattedStart),
    HOLD_ID: escapeHtml(input.holdId),
    ORDER_ID: escapeHtml(input.orderId),
    PAYMENT_PROVIDER: escapeHtml(input.paymentProvider),
    TIMEZONE: escapeHtml(input.timezone),
  };
}

function formatBookingConfirmationStart(start: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: timezone,
  }).format(start);
}

function toBookingConfirmationInput(
  hold: BookingConfirmationEmailClaimRecord,
  orderId: string,
): SendBookingConfirmationInput {
  return {
    addOnPaymentCopy: getBookingAddOnPaymentCopy(hold),
    bookingTypeLabel: getBookingTypeLabel(hold),
    email: hold.customer.email,
    holdId: hold.id,
    name: hold.customer.name,
    orderId,
    paymentProvider: hold.paymentProvider ?? "unknown",
    start: hold.selectedStart,
    timezone: hold.timezone,
  };
}

function getBookingTypeLabel(hold: BookingConfirmationEmailClaimRecord): string {
  const title = hold.offeringSnapshot.title;
  return typeof title === "string" && title.trim().length > 0 ? title : "lash appointment";
}

function getBookingAddOnPaymentCopy(hold: BookingConfirmationEmailClaimRecord): string | null {
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown email error";
}
