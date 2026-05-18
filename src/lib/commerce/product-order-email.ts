import "server-only";

import { Resend } from "resend";

import type { CheckoutOrderLineItemSnapshot } from "@/lib/private-db/schema";

export interface SendProductOrderConfirmationEmailInput {
  currency: string;
  customerEmail: string;
  customerName: string;
  lineItems: CheckoutOrderLineItemSnapshot[];
  orderId: string;
  totalAmount: number;
}

export async function sendProductOrderConfirmationEmail(
  input: SendProductOrderConfirmationEmailInput,
): Promise<void> {
  const resend = new Resend(getRequiredEnv("RESEND_API_KEY"));
  const fromEmail = getRequiredEnv("FROM_EMAIL");

  const { error } = await resend.emails.send({
    from: fromEmail,
    to: input.customerEmail,
    subject: "Your Lash Her order is confirmed",
    html: buildProductOrderConfirmationHtml(input),
  });

  if (error) {
    throw new Error(`Product order confirmation email failed: ${error.message}`);
  }
}

export function buildProductOrderConfirmationHtml(
  input: SendProductOrderConfirmationEmailInput,
): string {
  const formattedTotal = formatCurrency(input.totalAmount, input.currency);
  const itemRows = input.lineItems.map((lineItem) => getLineItemRow(lineItem, input.currency)).join("");

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Lash Her order is confirmed</title>
</head>
<body style="margin:0;padding:0;background-color:#f9f6ee;font-family:Inter,Arial,sans-serif;color:#2b1714;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" style="width:100%;max-width:640px;border-collapse:collapse;background-color:#fffaf1;border:1px solid #e8dcc8;">
          <tr>
            <td style="padding:34px 32px;text-align:center;background-color:#4b1230;color:#fffaf1;">
              <p style="margin:0 0 10px 0;font-size:12px;letter-spacing:0.22em;text-transform:uppercase;">Lash Her by Nataliea</p>
              <h1 style="margin:0;font-family:Georgia,serif;font-size:30px;font-weight:500;line-height:1.2;">Your order is confirmed</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:34px 32px;">
              <p style="margin:0 0 18px 0;font-size:16px;line-height:1.7;">Hi ${escapeHtml(input.customerName)},</p>
              <p style="margin:0 0 22px 0;font-size:15px;line-height:1.7;">Thank you for your Lash Her order. Your payment has been confirmed and your order is now being prepared for fulfillment.</p>
              <table role="presentation" style="width:100%;border-collapse:collapse;margin:28px 0;border-top:1px solid #e8dcc8;border-bottom:1px solid #e8dcc8;">
                <thead>
                  <tr>
                    <th align="left" style="padding:12px 0;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#6f5d55;">Item</th>
                    <th align="center" style="padding:12px 8px;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#6f5d55;">Qty</th>
                    <th align="right" style="padding:12px 0;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#6f5d55;">Total</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemRows}
                </tbody>
              </table>
              <p style="margin:0 0 18px 0;text-align:right;font-size:17px;line-height:1.7;"><strong>Total paid:</strong> ${escapeHtml(formattedTotal)}</p>
              <div style="margin:28px 0;padding:20px;border-left:4px solid #8b6f47;background-color:#f4ead8;">
                <p style="margin:0;font-size:14px;line-height:1.7;">You will receive fulfillment updates as your order is prepared. If you have questions about your purchase, reply to this confirmation or contact Lash Her support with your order number.</p>
              </div>
              <p style="margin:0;font-size:13px;line-height:1.7;color:#6f5d55;">Order ${escapeHtml(input.orderId)}</p>
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

function getLineItemRow(
  lineItem: CheckoutOrderLineItemSnapshot,
  currency: string,
): string {
  const sku = lineItem.sku.length > 0 ? ` <span style="color:#6f5d55;">(${escapeHtml(lineItem.sku)})</span>` : "";

  return `
<tr>
  <td style="padding:14px 0;border-top:1px solid #efe5d6;font-size:15px;line-height:1.5;">${escapeHtml(lineItem.description)}${sku}</td>
  <td align="center" style="padding:14px 8px;border-top:1px solid #efe5d6;font-size:15px;line-height:1.5;">${lineItem.quantity}</td>
  <td align="right" style="padding:14px 0;border-top:1px solid #efe5d6;font-size:15px;line-height:1.5;">${escapeHtml(formatCurrency(lineItem.totalCents / 100, currency))}</td>
</tr>
  `.trim();
}

function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-CA", {
    currency: currency.toUpperCase(),
    style: "currency",
  }).format(amount);
}

function escapeHtml(text: string): string {
  const replacements: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };

  return text.replace(/[&<>"']/g, (character) => replacements[character] ?? character);
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }

  return value;
}
