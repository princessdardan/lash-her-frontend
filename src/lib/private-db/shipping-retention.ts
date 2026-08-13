import "server-only";

import { inArray, sql } from "drizzle-orm";
import { getPrivateDb } from "./client";
import {
  checkoutOrders,
  productOrderAddressChangeRequests,
  productOrderCustomerDecisions,
  productShipmentEvents,
  productShipments,
  productShippingCases,
} from "./schema";

const DAY_MS = 24 * 60 * 60_000;
const REDACTED_ADDRESS = {
  line1: "[redacted]",
  city: "[redacted]",
  province: "--",
  postalCode: "[redacted]",
  country: "[redacted]",
};

export async function redactShippingPolicyPii(
  now = new Date(),
): Promise<number> {
  const terminalCutoff = new Date(now.getTime() - 180 * DAY_MS);
  const hardCutoff = new Date(now.getTime() - 365 * DAY_MS);
  const result = await getPrivateDb().execute<{ id: string }>(sql`
    select o.id
    from ${checkoutOrders} o
    where o.purpose = 'product'
      and o.redacted_at is null
      and (
        o.created_at <= ${hardCutoff}
        or (
          o.status in ('paid', 'verification_failed', 'cancelled', 'refunded')
          and not exists (
            select 1 from ${productShipments} s
            where s.order_id = o.id
              and s.status not in ('delivered', 'voided', 'abandoned')
          )
          and not exists (
            select 1 from product_order_refunds r
            where r.order_id = o.id
              and r.status not in ('succeeded', 'failed')
          )
          and not exists (
            select 1 from ${productShippingCases} c
            where c.order_id = o.id
              and c.status not in ('resolved', 'cancelled')
          )
          and not exists (
            select 1 from ${productOrderCustomerDecisions} d
            where d.order_id = o.id
              and d.status = 'pending'
          )
          and not exists (
            select 1 from ${productOrderAddressChangeRequests} a
            where a.order_id = o.id
              and a.status not in ('applied', 'rejected', 'expired', 'revoked')
          )
          and greatest(
            o.updated_at,
            coalesce((select max(s.updated_at) from ${productShipments} s where s.order_id = o.id), o.updated_at),
            coalesce((select max(r.updated_at) from product_order_refunds r where r.order_id = o.id), o.updated_at),
            coalesce((select max(c.updated_at) from ${productShippingCases} c where c.order_id = o.id), o.updated_at),
            coalesce((select max(d.updated_at) from ${productOrderCustomerDecisions} d where d.order_id = o.id), o.updated_at),
            coalesce((select max(a.updated_at) from ${productOrderAddressChangeRequests} a where a.order_id = o.id), o.updated_at)
          ) <= ${terminalCutoff}
        )
      )
  `);
  const ids = result.rows.map((row) => row.id);
  if (!ids.length) return 0;
  const db = getPrivateDb();
  await db.transaction(async (tx) => {
    const shipmentRows = await tx
      .select({ id: productShipments.id })
      .from(productShipments)
      .where(inArray(productShipments.orderId, ids));
    const shipmentIds = shipmentRows.map((row) => row.id);
    if (shipmentIds.length)
      await tx
        .update(productShipmentEvents)
        .set({ description: null, payload: null })
        .where(inArray(productShipmentEvents.shipmentId, shipmentIds));
    await tx
      .update(productShipments)
      .set({
        destination: REDACTED_ADDRESS,
        rates: [],
        rawShipment: null,
        quoteTokenHash: sql`'redacted:' || ${productShipments.id}::text`,
        trackingNumber: null,
        trackingUrl: null,
        redactedAt: now,
        updatedAt: now,
      })
      .where(inArray(productShipments.orderId, ids));
    await tx
      .update(productShippingCases)
      .set({ cause: null, redactedAt: now, updatedAt: now })
      .where(inArray(productShippingCases.orderId, ids));
    await tx
      .update(productOrderCustomerDecisions)
      .set({
        tokenHash: sql`'redacted:' || ${productOrderCustomerDecisions.id}::text`,
        selectedOutcome: null,
        redactedAt: now,
        updatedAt: now,
      })
      .where(inArray(productOrderCustomerDecisions.orderId, ids));
    await tx
      .update(productOrderAddressChangeRequests)
      .set({
        originalAddress: REDACTED_ADDRESS,
        proposedAddress: null,
        tokenHash: sql`'redacted:' || ${productOrderAddressChangeRequests.id}::text`,
        riskFlags: [],
        providerReconciliation: null,
        redactedAt: now,
        updatedAt: now,
      })
      .where(inArray(productOrderAddressChangeRequests.orderId, ids));
    await tx
      .update(checkoutOrders)
      .set({
        checkoutTokenHash: sql`'redacted:' || ${checkoutOrders.id}::text`,
        secretTokenCiphertext: "[redacted]",
        refundOriginIpCiphertext: null,
        customerName: "[redacted]",
        customerEmail: "[redacted]",
        shippingAddress: null,
        providerMetadata: null,
        fraudRiskReasons: [],
        productConfirmationEmailLastError: null,
        redactedAt: now,
        updatedAt: now,
      })
      .where(inArray(checkoutOrders.id, ids));
  });
  const [overdue] = await getPrivateDb()
    .select({ count: sql<number>`count(*)` })
    .from(checkoutOrders)
    .where(
      sql`${checkoutOrders.purpose} = 'product' and ${checkoutOrders.createdAt} <= ${hardCutoff} and ${checkoutOrders.redactedAt} is null`,
    );
  if (Number(overdue?.count ?? 0) > 0)
    throw new Error(
      "Unredacted product-order PII exceeds the 365-day hard cap",
    );
  return ids.length;
}
