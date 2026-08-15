import "server-only";

import { and, eq, gte, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import { shippingCustomerLinkIssuances } from "@/lib/private-db/schema";

export type ShippingCustomerLinkIssuanceTransaction = Parameters<
  Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
>[0];

export async function claimShippingCustomerLinkIssuance(
  tx: ShippingCustomerLinkIssuanceTransaction,
  input: {
    orderId: string;
    kind: "address_change" | "customer_decision" | "supplemental_payment";
    targetId: string;
    now: Date;
  },
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${"shipping-customer-link/" + input.orderId}))`,
  );
  const [existing] = await tx
    .select({ id: shippingCustomerLinkIssuances.id })
    .from(shippingCustomerLinkIssuances)
    .where(
      and(
        eq(shippingCustomerLinkIssuances.kind, input.kind),
        eq(shippingCustomerLinkIssuances.targetId, input.targetId),
      ),
    )
    .limit(1);
  if (existing) return;
  const [recent] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(shippingCustomerLinkIssuances)
    .where(
      and(
        eq(shippingCustomerLinkIssuances.orderId, input.orderId),
        gte(
          shippingCustomerLinkIssuances.issuedAt,
          new Date(input.now.getTime() - 24 * 60 * 60_000),
        ),
      ),
    );
  if (Number(recent?.count ?? 0) >= 3) {
    throw new Error("Customer link issuance limit reached");
  }
  await tx.insert(shippingCustomerLinkIssuances).values(input);
}
