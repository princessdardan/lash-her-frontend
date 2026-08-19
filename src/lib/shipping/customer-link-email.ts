import "server-only";

import {
  CUSTOMER_REPLY_TO_EMAIL,
  escapeHtml,
  sendTransactionalEmail,
} from "@/lib/transactional-email";
import {
  enqueueCustomerEmail,
  type CustomerEmailOutboxTransaction,
} from "@/lib/commerce/customer-email-outbox";

export async function sendShippingCustomerLinkEmail(input: {
  to: string;
  orderReference: string;
  link: string;
  purpose: "decision" | "address-change" | "payment-offer";
  idempotencyKey: string;
  orderDatabaseId: string;
  now?: Date;
  executor?: CustomerEmailOutboxTransaction;
}): Promise<void> {
  await enqueueCustomerEmail(
    {
      kind: "shipping_customer_link",
      recipient: input.to,
      orderDatabaseId: input.orderDatabaseId,
      providerIdempotencyKey: input.idempotencyKey,
      payload: {
        orderReference: input.orderReference,
        link: input.link,
        purpose: input.purpose,
      },
      now: input.now,
    },
    input.executor,
  );
}

export async function deliverShippingCustomerLinkEmail(input: {
  to: string;
  orderReference: string;
  link: string;
  purpose: "decision" | "address-change" | "payment-offer";
  idempotencyKey: string;
}): Promise<{ id: string }> {
  const addressChange = input.purpose === "address-change";
  const paymentOffer = input.purpose === "payment-offer";
  const title = paymentOffer
    ? "A supplemental payment is ready"
    : addressChange
      ? "Secure shipping address change"
      : "A shipping decision is required";
  return sendTransactionalEmail({
    to: input.to,
    replyTo: CUSTOMER_REPLY_TO_EMAIL,
    subject: `${title} — ${input.orderReference}`,
    idempotencyKey: input.idempotencyKey,
    tags: [{ name: "category", value: `shipping-${input.purpose}` }],
    html: `<p>${escapeHtml(title)}</p><p>Order ${escapeHtml(input.orderReference)}</p><p><a href="${escapeHtml(input.link)}">${paymentOffer ? "Review the payment offer" : "Open the secure form"}</a></p><p>${addressChange ? "This link expires in 30 minutes." : "The page shows the applicable deadline."} The link can be exchanged once and was sent only to the original checkout email.</p>`,
  });
}
