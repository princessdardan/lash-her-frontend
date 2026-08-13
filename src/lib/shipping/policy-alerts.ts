import "server-only";

import { and, eq, inArray, or } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  adminUsers,
  shippingPolicyAssignments,
  type ShippingPolicyDuty,
} from "@/lib/private-db/schema";
import { escapeHtml, sendTransactionalEmail } from "@/lib/transactional-email";

export async function sendShippingPolicyAlert(input: {
  duties: ShippingPolicyDuty[];
  subject: string;
  message: string;
  idempotencyKey: string;
  critical?: boolean;
}): Promise<number> {
  const rows = await getPrivateDb()
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
  await sendTransactionalEmail({
    to: recipients,
    subject: input.subject,
    idempotencyKey: input.idempotencyKey,
    tags: [{ name: "category", value: "shipping-policy-alert" }],
    html: `<p>${escapeHtml(input.message)}</p>`,
  });
  return recipients.length;
}

export async function sendShippingCustomerUpdate(input: {
  to: string;
  orderReference: string;
  subject: string;
  message: string;
  idempotencyKey: string;
}): Promise<void> {
  await sendTransactionalEmail({
    to: input.to,
    subject: input.subject,
    idempotencyKey: input.idempotencyKey,
    tags: [{ name: "category", value: "shipping-policy-customer" }],
    html: `<p>Order ${escapeHtml(input.orderReference)}</p><p>${escapeHtml(input.message)}</p>`,
  });
}
