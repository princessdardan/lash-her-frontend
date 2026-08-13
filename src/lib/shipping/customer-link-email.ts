import "server-only";

import {
  CUSTOMER_REPLY_TO_EMAIL,
  escapeHtml,
  sendTransactionalEmail,
} from "@/lib/transactional-email";

export async function sendShippingCustomerLinkEmail(input: {
  to: string;
  orderReference: string;
  link: string;
  purpose: "decision" | "address-change";
  idempotencyKey: string;
}): Promise<void> {
  const addressChange = input.purpose === "address-change";
  const title = addressChange
    ? "Secure shipping address change"
    : "A shipping decision is required";
  await sendTransactionalEmail({
    to: input.to,
    replyTo: CUSTOMER_REPLY_TO_EMAIL,
    subject: `${title} — ${input.orderReference}`,
    idempotencyKey: input.idempotencyKey,
    tags: [{ name: "category", value: `shipping-${input.purpose}` }],
    html: `<p>${escapeHtml(title)}</p><p>Order ${escapeHtml(input.orderReference)}</p><p><a href="${escapeHtml(input.link)}">Open the secure form</a></p><p>${addressChange ? "This link expires in 30 minutes." : "The form shows the applicable deadline."} The link can be used once and was sent only to the original checkout email.</p>`,
  });
}
