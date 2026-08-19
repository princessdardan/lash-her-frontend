import "server-only";

import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getPrivateDb } from "@/lib/private-db/client";
import { adminUsers, type ShippingPolicyDuty } from "@/lib/private-db/schema";
import { configuredOwnerEmails } from "@/lib/shipping/configured-owner";
import { escapeHtml, sendTransactionalEmail } from "@/lib/transactional-email";
import {
  enqueueCustomerEmail,
  type CustomerEmailOutboxTransaction,
} from "@/lib/commerce/customer-email-outbox";

/**
 * Shipping policy alerts route to the fulfillment owner.
 *
 * Duty-based routing (`shipping_policy_assignments`) has been removed: for a
 * solo-operator business every duty was held by the same person, so alerts are
 * delivered to the active `role='owner'` admins (and any address configured via
 * `ADMIN_OWNER_EMAILS`). The `duties` field is retained on the input for caller
 * compatibility and to describe the alert, but no longer selects recipients.
 */
export async function sendShippingPolicyAlert(input: {
  duties: ShippingPolicyDuty[];
  subject: string;
  message: string;
  idempotencyKey: string;
  critical?: boolean;
  now?: Date;
  executor?: CustomerEmailOutboxTransaction;
}): Promise<number> {
  const executor = input.executor ?? getPrivateDb();
  const rows = await executor
    .select({ email: adminUsers.email })
    .from(adminUsers)
    .where(and(eq(adminUsers.status, "active"), eq(adminUsers.role, "owner")));
  const recipients = [
    ...new Set(
      rows
        .map((row) => row.email)
        .filter(
          (email): email is string =>
            typeof email === "string" && email.trim().length > 0,
        ),
    ),
  ];
  if (!recipients.length) {
    // Fall back to the explicitly configured owner mailbox when no active
    // owner admin row is present (e.g. seeded environments).
    recipients.push(...configuredOwnerEmails());
  }
  if (!recipients.length)
    throw new Error("No active fulfillment owner to receive shipping alerts");
  await Promise.all(
    recipients.map((recipient) =>
      enqueueCustomerEmail(
        {
          kind: "shipping_policy_alert",
          recipient,
          providerIdempotencyKey: `${input.idempotencyKey}/${recipientKey(recipient)}`,
          payload: {
            subject: input.subject,
            message: input.message,
            critical: input.critical === true,
          },
          now: input.now,
        },
        input.executor,
      ),
    ),
  );
  return recipients.length;
}

export async function sendShippingCustomerUpdate(input: {
  to: string;
  orderReference: string;
  subject: string;
  message: string;
  idempotencyKey: string;
  orderDatabaseId: string;
  now?: Date;
  executor?: CustomerEmailOutboxTransaction;
}): Promise<void> {
  await enqueueCustomerEmail(
    {
      kind: "shipping_customer_update",
      recipient: input.to,
      orderDatabaseId: input.orderDatabaseId,
      providerIdempotencyKey: input.idempotencyKey,
      payload: {
        orderReference: input.orderReference,
        subject: input.subject,
        message: input.message,
      },
      now: input.now,
    },
    input.executor,
  );
}

export async function deliverShippingCustomerUpdate(input: {
  to: string;
  orderReference: string;
  subject: string;
  message: string;
  idempotencyKey: string;
}): Promise<{ id: string }> {
  return sendTransactionalEmail({
    to: input.to,
    subject: input.subject,
    idempotencyKey: input.idempotencyKey,
    tags: [{ name: "category", value: "shipping-policy-customer" }],
    html: `<p>Order ${escapeHtml(input.orderReference)}</p><p>${escapeHtml(input.message)}</p>`,
  });
}

export async function deliverShippingPolicyAlertEmail(input: {
  to: string;
  subject: string;
  message: string;
  critical: boolean;
  idempotencyKey: string;
}): Promise<{ id: string }> {
  return sendTransactionalEmail({
    to: input.to,
    subject: input.subject,
    idempotencyKey: input.idempotencyKey,
    tags: [{ name: "category", value: "shipping-policy-alert" }],
    html: `<p>${escapeHtml(input.message)}</p>`,
  });
}

function recipientKey(recipient: string): string {
  return createHash("sha256")
    .update(recipient.trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);
}
