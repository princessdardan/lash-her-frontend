import "server-only";

import { inArray, sql } from "drizzle-orm";
import { getPrivateDb } from "./client";
import {
  checkoutOrders,
  customerEmailOutbox,
  fulfillmentOwnerActions,
  orderPaymentObligations,
  orderPaymentTransactions,
  productOrderAddressChangeRequests,
  productOrderAdjustments,
  productOrderCustomerDecisions,
  productOrderRefunds,
  productOrderRiskReviews,
  productPaymentRiskIncidents,
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
  const db = getPrivateDb();
  return db.transaction(async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      select o.id
      from ${checkoutOrders} o
      where o.purpose = 'product'
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
              select 1 from ${productOrderRefunds} r
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
              where d.order_id = o.id and d.status = 'pending'
            )
            and not exists (
              select 1 from ${productOrderAddressChangeRequests} a
              where a.order_id = o.id
                and a.status not in ('applied', 'rejected', 'expired', 'revoked')
            )
            and greatest(
              o.updated_at,
              coalesce((select max(s.updated_at) from ${productShipments} s where s.order_id = o.id), o.updated_at),
              coalesce((select max(r.updated_at) from ${productOrderRefunds} r where r.order_id = o.id), o.updated_at),
              coalesce((select max(c.updated_at) from ${productShippingCases} c where c.order_id = o.id), o.updated_at),
              coalesce((select max(d.updated_at) from ${productOrderCustomerDecisions} d where d.order_id = o.id), o.updated_at),
              coalesce((select max(a.updated_at) from ${productOrderAddressChangeRequests} a where a.order_id = o.id), o.updated_at)
            ) <= ${terminalCutoff}
          )
        )
      for update of o
    `);
    const ids = result.rows.map((row) => row.id);

    await tx
      .update(customerEmailOutbox)
      .set({
        recipientCiphertext: "[redacted]",
        templateDataCiphertext: "[redacted]",
        lastError: null,
        redactedAt: now,
        updatedAt: now,
      })
      .where(
        sql`${customerEmailOutbox.redactionDueAt} <= ${now} and ${customerEmailOutbox.redactedAt} is null`,
      );
    if (!ids.length) return 0;

    const shipmentRows = await tx
      .select({ id: productShipments.id })
      .from(productShipments)
      .where(inArray(productShipments.orderId, ids));
    const shipmentIds = shipmentRows.map((row) => row.id);
    if (shipmentIds.length) {
      await tx
        .update(productShipmentEvents)
        .set({ description: null, payload: null })
        .where(inArray(productShipmentEvents.shipmentId, shipmentIds));
    }
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
      .set({
        cause: null,
        evidenceChecklist: {},
        redactedAt: now,
        updatedAt: now,
      })
      .where(inArray(productShippingCases.orderId, ids));
    await tx
      .update(productOrderCustomerDecisions)
      .set({
        tokenHash: sql`'redacted:' || ${productOrderCustomerDecisions.id}::text`,
        proposedConditions: null,
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
        ownerRationale: null,
        redactedAt: now,
        updatedAt: now,
      })
      .where(inArray(productOrderAddressChangeRequests.orderId, ids));
    await tx
      .update(productOrderRefunds)
      .set({ reason: "[redacted]", redactedAt: now, updatedAt: now })
      .where(inArray(productOrderRefunds.orderId, ids));
    await tx
      .update(productOrderRiskReviews)
      .set({ rationale: "[redacted]", evidence: null, redactedAt: now })
      .where(inArray(productOrderRiskReviews.orderId, ids));
    await tx
      .update(productPaymentRiskIncidents)
      .set({
        providerEvidence: null,
        rationale: null,
        reasonCodes: [],
        redactedAt: now,
        updatedAt: now,
      })
      .where(inArray(productPaymentRiskIncidents.orderId, ids));
    await tx
      .update(fulfillmentOwnerActions)
      .set({ rationale: "[redacted]", evidence: {}, redactedAt: now })
      .where(
        sql`${fulfillmentOwnerActions.targetId} in (
          select id::text from ${productPaymentRiskIncidents} where order_id in (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
          union select id::text from ${productOrderAddressChangeRequests} where order_id in (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
        )`,
      );
    await tx
      .update(orderPaymentObligations)
      .set({ disclosureSnapshot: null, redactedAt: now, updatedAt: now })
      .where(inArray(orderPaymentObligations.orderId, ids));
    const obligationRows = await tx
      .select({ id: orderPaymentObligations.id })
      .from(orderPaymentObligations)
      .where(inArray(orderPaymentObligations.orderId, ids));
    if (obligationRows.length) {
      await tx
        .update(orderPaymentTransactions)
        .set({
          originatingIpCiphertext: null,
          avsCode: null,
          cvvCode: null,
          riskReasonCodes: [],
          redactedAt: now,
        })
        .where(
          inArray(
            orderPaymentTransactions.obligationId,
            obligationRows.map((row) => row.id),
          ),
        );
    }
    await tx
      .update(productOrderAdjustments)
      .set({ reason: "[redacted]", redactedAt: now, updatedAt: now })
      .where(inArray(productOrderAdjustments.orderId, ids));
    await tx
      .update(customerEmailOutbox)
      .set({
        recipientCiphertext: "[redacted]",
        templateDataCiphertext: "[redacted]",
        lastError: null,
        redactedAt: now,
        updatedAt: now,
      })
      .where(inArray(customerEmailOutbox.orderId, ids));
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

    const [overdue] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(checkoutOrders)
      .where(
        sql`${checkoutOrders.purpose} = 'product' and ${checkoutOrders.createdAt} <= ${hardCutoff} and ${checkoutOrders.redactedAt} is null`,
      );
    if (Number(overdue?.count ?? 0) > 0) {
      throw new Error(
        "Unredacted product-order PII exceeds the 365-day hard cap",
      );
    }
    return ids.length;
  });
}
