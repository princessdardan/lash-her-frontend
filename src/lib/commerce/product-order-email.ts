import "server-only";

import type {
  CheckoutOrderLineItemSnapshot,
  CheckoutOrderShippingAddressSnapshot,
} from "@/lib/private-db/schema";
import {
  claimProductOrderConfirmationEmail,
  markProductOrderConfirmationEmailSent,
  recordProductOrderConfirmationEmailFailure,
} from "@/lib/commerce/order-store";
import { CUSTOMER_REPLY_TO_EMAIL, escapeHtml, sendTransactionalEmail } from "@/lib/transactional-email";

export interface SendProductOrderConfirmationEmailInput {
  currency: string;
  customerEmail: string;
  customerName: string;
  lineItems: CheckoutOrderLineItemSnapshot[];
  orderId: string;
  shippingAddress: CheckoutOrderShippingAddressSnapshot | null;
  totalAmount: number;
}

export interface SendProductOrderConfirmationEmailForOrderDependencies {
  claimProductOrderConfirmationEmail: typeof claimProductOrderConfirmationEmail;
  logError: typeof console.error;
  markProductOrderConfirmationEmailSent: typeof markProductOrderConfirmationEmailSent;
  recordProductOrderConfirmationEmailFailure: typeof recordProductOrderConfirmationEmailFailure;
  sendProductOrderConfirmationEmail: typeof sendProductOrderConfirmationEmail;
}

export async function sendProductOrderConfirmationEmail(
  input: SendProductOrderConfirmationEmailInput,
): Promise<void> {
  await sendTransactionalEmail({
    html: buildProductOrderConfirmationHtml(input),
    idempotencyKey: `product-confirmation:${input.orderId}`,
    replyTo: CUSTOMER_REPLY_TO_EMAIL,
    subject: "Your Lash Her order is confirmed",
    tags: [
      { name: "flow", value: "product_confirmation" },
      { name: "order_id", value: input.orderId },
      { name: "payment_provider", value: "helcim" },
    ],
    to: input.customerEmail,
  });
}

export async function sendProductOrderConfirmationEmailForOrder(
  orderId: string,
  dependencies: SendProductOrderConfirmationEmailForOrderDependencies = defaultSendProductOrderConfirmationEmailForOrderDependencies,
): Promise<void> {
  const claimed = await dependencies.claimProductOrderConfirmationEmail({ orderId });

  if (claimed === null) {
    return;
  }

  try {
    await dependencies.sendProductOrderConfirmationEmail(claimed);
    await dependencies.markProductOrderConfirmationEmailSent(orderId);
  } catch (error) {
    const message = getErrorMessage(error);
    await dependencies.recordProductOrderConfirmationEmailFailure({
      error: message,
      orderId,
    });
    dependencies.logError("[checkout] Product order confirmation email failed", {
      error: message,
      orderId,
    });
    throw new Error(message, { cause: error });
  }
}

const defaultSendProductOrderConfirmationEmailForOrderDependencies: SendProductOrderConfirmationEmailForOrderDependencies = {
  claimProductOrderConfirmationEmail,
  logError: console.error,
  markProductOrderConfirmationEmailSent,
  recordProductOrderConfirmationEmailFailure,
  sendProductOrderConfirmationEmail,
};

export function buildProductOrderConfirmationHtml(
  input: SendProductOrderConfirmationEmailInput,
): string {
  const formattedTotal = formatCurrency(input.totalAmount, input.currency);
  const itemRows = input.lineItems.map((lineItem) => getLineItemRow(lineItem, input.currency)).join("");
  const shippingAddress = input.shippingAddress ? getShippingAddressHtml(input.shippingAddress) : "";

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Lash Her order is confirmed</title>
</head>
<body style="margin:0;padding:0;background-color:#F5F1F5;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1C1318;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" style="width:100%;max-width:640px;border-collapse:collapse;background-color:#FFFFFF;border:1px solid #E8E2E9;">
          <tr>
            <td style="padding:34px 32px;text-align:center;background-color:#1C1318;color:#FFFFFF;">
              <p style="margin:0 0 10px 0;font-size:12px;letter-spacing:0.22em;text-transform:uppercase;">Lash Her by Nataliea</p>
              <h1 style="margin:0;font-family:'Bebas Neue','Arial Narrow',Impact,sans-serif;letter-spacing:0.04em;text-transform:uppercase;font-size:30px;font-weight:500;line-height:1.2;">Your order is confirmed</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:34px 32px;">
              <p style="margin:0 0 18px 0;font-size:16px;line-height:1.7;">Hi ${escapeHtml(input.customerName)},</p>
              <p style="margin:0 0 22px 0;font-size:15px;line-height:1.7;">Thank you for your Lash Her order. Your payment has been confirmed and your order is now being prepared for fulfillment.</p>
              ${shippingAddress}
              <table role="presentation" style="width:100%;border-collapse:collapse;margin:28px 0;border-top:1px solid #E8E2E9;border-bottom:1px solid #E8E2E9;">
                <thead>
                  <tr>
                    <th align="left" style="padding:12px 0;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#746A72;">Item</th>
                    <th align="center" style="padding:12px 8px;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#746A72;">Qty</th>
                    <th align="right" style="padding:12px 0;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#746A72;">Total</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemRows}
                </tbody>
              </table>
              <p style="margin:0 0 18px 0;text-align:right;font-size:17px;line-height:1.7;"><strong>Total paid:</strong> ${escapeHtml(formattedTotal)}</p>
              <div style="margin:28px 0;padding:20px;border-left:4px solid #D4B483;background-color:#F5F1F5;">
                <p style="margin:0;font-size:14px;line-height:1.7;">You will receive fulfillment updates as your order is prepared. If you have questions about your purchase, reply to this confirmation or contact Lash Her support with your order number.</p>
              </div>
              <p style="margin:0;font-size:13px;line-height:1.7;color:#746A72;">Order ${escapeHtml(input.orderId)}</p>
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

function getShippingAddressHtml(address: CheckoutOrderShippingAddressSnapshot): string {
  const lines = [
    address.line1,
    address.line2,
    `${address.city}, ${address.province} ${address.postalCode}`,
    address.country,
  ].filter((line): line is string => Boolean(line));

  return `
<div style="margin:24px 0;padding:18px;border:1px solid #E8E2E9;background-color:#FFFFFF;">
  <p style="margin:0 0 10px 0;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#746A72;">Shipping to</p>
  <p style="margin:0;font-size:14px;line-height:1.7;">${lines.map(escapeHtml).join("<br>")}</p>
</div>
  `.trim();
}

function getLineItemRow(
  lineItem: CheckoutOrderLineItemSnapshot,
  currency: string,
): string {
  return `
<tr>
  <td style="padding:14px 0;border-top:1px solid #E8E2E9;font-size:15px;line-height:1.5;">${escapeHtml(lineItem.description)}</td>
  <td align="center" style="padding:14px 8px;border-top:1px solid #E8E2E9;font-size:15px;line-height:1.5;">${lineItem.quantity}</td>
  <td align="right" style="padding:14px 0;border-top:1px solid #E8E2E9;font-size:15px;line-height:1.5;">${escapeHtml(formatCurrency(lineItem.totalCents / 100, currency))}</td>
</tr>
  `.trim();
}

function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-CA", {
    currency: currency.toUpperCase(),
    style: "currency",
  }).format(amount);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown email error";
}
