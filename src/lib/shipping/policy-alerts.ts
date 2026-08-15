import "server-only";

import { and, eq, inArray, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  adminUsers,
  shippingPolicyAssignments,
  type ShippingPolicyDuty,
} from "@/lib/private-db/schema";
import { escapeHtml, sendTransactionalEmail } from "@/lib/transactional-email";
import {
  enqueueCustomerEmail,
  type CustomerEmailOutboxTransaction,
} from "@/lib/commerce/customer-email-outbox";

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
    .leftJoin(
      shippingPolicyAssignments,
      and(
        eq(shippingPolicyAssignments.adminUserId, adminUsers.id),
        eq(shippingPolicyAssignments.active, true),
      ),
    )
    .where(
      and(
        eq(adminUsers.status, "active"),
        or(
          inArray(shippingPolicyAssignments.duty, input.duties),
          ...(input.critical ? [eq(adminUsers.role, "owner")] : []),
        ),
      ),
    );
  const recipients = [...new Set(rows.map((row) => row.email))];
  if (!recipients.length)
    throw new Error("Shipping policy role has no active assignee");
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
