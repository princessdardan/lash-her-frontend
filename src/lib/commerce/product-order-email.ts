import "server-only";

import type {
  CheckoutOrderLineItemSnapshot,
  CheckoutOrderShippingAddressSnapshot,
  UsImportDisclosureSnapshot,
} from "@/lib/private-db/schema";
import {
  claimProductOrderConfirmationEmail,
  enqueuePaidProductOrderConfirmationEmail,
  recordProductOrderConfirmationEmailFailure,
} from "@/lib/commerce/order-store";
import { enqueueCustomerEmail } from "@/lib/commerce/customer-email-outbox";
import { getConfiguredTransactionalTemplate } from "@/lib/resend-platform";
import {
  CUSTOMER_REPLY_TO_EMAIL,
  escapeHtml,
  getEmailProfileImageHtml,
  sendTransactionalEmail,
} from "@/lib/transactional-email";

export interface SendProductOrderConfirmationEmailInput {
  currency: string;
  customerEmail: string;
  customerName: string;
  lineItems: CheckoutOrderLineItemSnapshot[];
  merchandiseAmount?: number;
  orderId: string;
  shippingAmount?: number;
  shippingAddress: CheckoutOrderShippingAddressSnapshot | null;
  totalAmount: number;
  paymentRiskStatus?:
    | "not_required"
    | "pending"
    | "cleared"
    | "review_required";
  promotionCode?: string | null;
  promotionDiscount?: number;
  manualDiscount?: number;
  taxAmount?: number;
  fulfillmentMode?: "automated_shipping" | "manual_pickup" | "manual_shipping";
  usImportDisclosure?: UsImportDisclosureSnapshot | null;
}

export interface SendProductOrderConfirmationEmailForOrderDependencies {
  claimProductOrderConfirmationEmail: typeof claimProductOrderConfirmationEmail;
  enqueuePaidProductOrderConfirmationEmail?: typeof enqueuePaidProductOrderConfirmationEmail;
  enqueueCustomerEmail: typeof enqueueCustomerEmail;
  logError: typeof console.error;
  recordProductOrderConfirmationEmailFailure: typeof recordProductOrderConfirmationEmailFailure;
}

export const PRODUCT_ORDER_CONFIRMATION_EMAIL_SUBJECT =
  "Your Lash Her order is confirmed";

export async function sendProductOrderConfirmationEmail(
  input: SendProductOrderConfirmationEmailInput,
): Promise<{ id: string }> {
  const copy = getEmailCopy(input);
  return sendTransactionalEmail({
    html: buildProductOrderConfirmationHtml(input),
    idempotencyKey: `product-confirmation:${input.orderId}`,
    replyTo: CUSTOMER_REPLY_TO_EMAIL,
    subject: copy.subject,
    tags: [
      { name: "flow", value: "product_confirmation" },
      { name: "order_id", value: input.orderId },
      { name: "payment_provider", value: "helcim" },
    ],
    template: getConfiguredTransactionalTemplate(
      "product_confirmation",
      getProductOrderTemplateVariables(input),
    ),
    to: input.customerEmail,
  });
}

function getEmailCopy(input: SendProductOrderConfirmationEmailInput) {
  const held =
    input.paymentRiskStatus === "pending" ||
    input.paymentRiskStatus === "review_required";
  const manualPickup = input.fulfillmentMode === "manual_pickup";
  const manualShipping = input.fulfillmentMode === "manual_shipping";
  return {
    subject: held
      ? "Payment received for your Lash Her order"
      : manualPickup
        ? "Payment received — Lash Her pickup arrangement pending"
        : manualShipping
          ? "Payment received — Lash Her manual shipping arrangement pending"
          : PRODUCT_ORDER_CONFIRMATION_EMAIL_SUBJECT,
    heading: held
      ? "Payment received"
      : manualPickup
        ? "Pickup arrangement pending"
        : manualShipping
          ? "Shipping arrangement pending"
          : "Your order is confirmed",
    introduction: held
      ? "Payment received; fulfillment confirmation is under review."
      : input.fulfillmentMode === "manual_pickup"
        ? "Thank you for your Lash Her order. Your payment has been confirmed and pickup details will be arranged separately."
        : input.fulfillmentMode === "manual_shipping"
          ? "Thank you for your Lash Her order. Your merchandise payment has been confirmed. Shipping will be arranged separately and any approved shipping charge will use a separate secure payment request."
          : "Thank you for your Lash Her order. Your payment has been confirmed and your order is now being prepared for fulfillment.",
    nextSteps: held
      ? "You will receive another update after the review is complete. If you have questions, reply with your order number."
      : "You will receive fulfillment updates as your order is prepared. If you have questions about your purchase, reply to this confirmation or contact Lash Her support with your order number.",
  };
}

export async function sendProductOrderConfirmationEmailForOrder(
  orderId: string,
  dependencies: SendProductOrderConfirmationEmailForOrderDependencies = defaultSendProductOrderConfirmationEmailForOrderDependencies,
): Promise<void> {
  if (dependencies.enqueuePaidProductOrderConfirmationEmail) {
    await dependencies.enqueuePaidProductOrderConfirmationEmail({ orderId });
    return;
  }
  const claimed = await dependencies.claimProductOrderConfirmationEmail({
    orderId,
  });

  if (claimed === null) {
    return;
  }

  try {
    await dependencies.enqueueCustomerEmail({
      kind: "product_order_confirmation",
      orderDatabaseId: claimed.orderDatabaseId,
      payload: claimed,
      providerIdempotencyKey: `product-confirmation:${claimed.orderId}`,
      recipient: claimed.customerEmail,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    await dependencies.recordProductOrderConfirmationEmailFailure({
      error: message,
      orderId,
    });
    dependencies.logError(
      "[checkout] Product order confirmation email failed",
      {
        error: message,
        orderId,
      },
    );
    throw new Error(message, { cause: error });
  }
}

const defaultSendProductOrderConfirmationEmailForOrderDependencies: SendProductOrderConfirmationEmailForOrderDependencies =
  {
    claimProductOrderConfirmationEmail,
    enqueuePaidProductOrderConfirmationEmail,
    enqueueCustomerEmail,
    logError: console.error,
    recordProductOrderConfirmationEmailFailure,
  };

export function buildProductOrderConfirmationHtml(
  input: SendProductOrderConfirmationEmailInput,
): string {
  const formattedTotal = formatCurrency(input.totalAmount, input.currency);
  const shippingSummary = getShippingSummaryHtml(input);
  const itemRows = input.lineItems
    .map((lineItem) => getLineItemRow(lineItem, input.currency))
    .join("");
  const shippingAddress = input.shippingAddress
    ? getShippingAddressHtml(input.shippingAddress)
    : "";
  const copy = getEmailCopy(input);
  const importDisclosure = getImportDisclosureHtml(input);

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(copy.subject)}</title>
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
              <h1 style="margin:0;font-family:'Bebas Neue','Arial Narrow',Impact,sans-serif;letter-spacing:0.04em;text-transform:uppercase;font-size:30px;font-weight:500;line-height:1.2;">${escapeHtml(copy.heading)}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:34px 32px;">
              <p style="margin:0 0 18px 0;font-size:16px;line-height:1.7;">Hi ${escapeHtml(input.customerName)},</p>
              <p style="margin:0 0 22px 0;font-size:15px;line-height:1.7;">${escapeHtml(copy.introduction)}</p>
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
              ${shippingSummary}
              ${importDisclosure}
              <p style="margin:0 0 18px 0;text-align:right;font-size:17px;line-height:1.7;"><strong>Total paid:</strong> ${escapeHtml(formattedTotal)}</p>
              <div style="margin:28px 0;padding:20px;border-left:4px solid #D4B483;background-color:#F5F1F5;">
                <p style="margin:0;font-size:14px;line-height:1.7;">${escapeHtml(copy.nextSteps)}</p>
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

export function getProductOrderTemplateVariables(
  input: SendProductOrderConfirmationEmailInput,
): Record<string, unknown> {
  const lineItemsHtml = input.lineItems
    .map((lineItem) => getLineItemRow(lineItem, input.currency))
    .join("");
  const copy = getEmailCopy(input);

  return {
    CURRENCY: escapeHtml(input.currency.toUpperCase()),
    CUSTOMER_EMAIL: escapeHtml(input.customerEmail),
    CUSTOMER_FIRST_NAME: escapeHtml(
      input.customerName.trim().split(/\s+/)[0] ?? "",
    ),
    CUSTOMER_NAME: escapeHtml(input.customerName),
    ITEM_COUNT: input.lineItems.reduce(
      (total, lineItem) => total + lineItem.quantity,
      0,
    ),
    LINE_ITEMS_HTML: lineItemsHtml,
    EMAIL_SUBJECT: copy.subject,
    STATUS_HEADING: copy.heading,
    INTRODUCTION: copy.introduction,
    NEXT_STEPS: copy.nextSteps,
    PRICING_SUMMARY_HTML: getShippingSummaryHtml(input),
    IMPORT_DISCLOSURE_HTML: getImportDisclosureHtml(input),
    ORDER_ID: escapeHtml(input.orderId),
    SHIPPING_ADDRESS_HTML: input.shippingAddress
      ? getShippingAddressHtml(input.shippingAddress)
      : "",
    SHIPPING_AMOUNT: escapeHtml(
      formatCurrency(input.shippingAmount ?? 0, input.currency),
    ),
    SUBTOTAL: escapeHtml(
      formatCurrency(
        input.merchandiseAmount ??
          input.totalAmount - (input.shippingAmount ?? 0),
        input.currency,
      ),
    ),
    TOTAL: escapeHtml(formatCurrency(input.totalAmount, input.currency)),
  };
}

function getShippingSummaryHtml(
  input: SendProductOrderConfirmationEmailInput,
): string {
  const merchandiseAmount =
    input.merchandiseAmount ??
    input.totalAmount - (input.shippingAmount ?? 0) - (input.taxAmount ?? 0);
  const promotionDiscount = input.promotionDiscount ?? 0;
  const manualDiscount = input.manualDiscount ?? 0;
  const merchandiseBeforeDiscounts =
    merchandiseAmount + promotionDiscount + manualDiscount;
  const taxAmount = input.taxAmount ?? 0;
  return `
<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 10px 0;font-size:14px;line-height:1.7;">
  <tr><td align="right" style="color:#746A72;">Merchandise</td><td align="right" style="width:120px;">${escapeHtml(formatCurrency(merchandiseBeforeDiscounts, input.currency))}</td></tr>
  ${manualDiscount > 0 ? `<tr><td align="right" style="color:#746A72;">Sale discount</td><td align="right">-${escapeHtml(formatCurrency(manualDiscount, input.currency))}</td></tr>` : ""}
  ${promotionDiscount > 0 ? `<tr><td align="right" style="color:#746A72;">Promotion${input.promotionCode ? ` (${escapeHtml(input.promotionCode)})` : ""}</td><td align="right">-${escapeHtml(formatCurrency(promotionDiscount, input.currency))}</td></tr>` : ""}
  <tr><td align="right" style="color:#746A72;">${input.fulfillmentMode === "manual_pickup" ? "Studio pickup" : input.fulfillmentMode === "manual_shipping" ? "Shipping arranged separately" : input.shippingAmount && input.shippingAmount > 0 ? "Insured tracked shipping" : "Shipping"}</td><td align="right">${input.fulfillmentMode === "manual_shipping" ? "Not charged" : escapeHtml(formatCurrency(input.shippingAmount ?? 0, input.currency))}</td></tr>
  <tr><td align="right" style="color:#746A72;">Tax</td><td align="right">${escapeHtml(formatCurrency(taxAmount, input.currency))}</td></tr>
</table>
  `.trim();
}

function getImportDisclosureHtml(
  input: SendProductOrderConfirmationEmailInput,
): string {
  const disclosure = input.usImportDisclosure;
  if (!disclosure) return "";
  return `
<div style="margin:20px 0;padding:18px;border:1px solid #D4B483;background-color:#F5F1F5;" data-import-terms="${escapeHtml(disclosure.terms)}" data-disclosure-version="${escapeHtml(disclosure.version)}">
  <p style="margin:0 0 8px 0;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#746A72;">U.S. import terms: ${escapeHtml(disclosure.terms)}</p>
  <p style="margin:0;font-size:14px;line-height:1.7;">${escapeHtml(disclosure.text)}</p>
</div>
  `.trim();
}

function getShippingAddressHtml(
  address: CheckoutOrderShippingAddressSnapshot,
): string {
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
  const title = lineItem.productTitle ?? lineItem.description;
  const details = [
    lineItem.variantTitle,
    ...(lineItem.selectedOptions ?? []).map(
      (option) => `${option.label}: ${option.value}`,
    ),
  ].filter((value): value is string => Boolean(value));
  return `
<tr>
  <td style="padding:14px 0;border-top:1px solid #E8E2E9;font-size:15px;line-height:1.5;">${escapeHtml(title)}${details.length ? `<br><span style="font-size:13px;color:#746A72;">${details.map(escapeHtml).join(" · ")}</span>` : ""}</td>
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
