import "server-only";

import { inArray, sql, type SQLWrapper } from "drizzle-orm";
import { getPrivateDb } from "./client";
import {
  checkoutOrders,
  customerEmailOutbox,
  orderPaymentObligations,
  orderPaymentTransactions,
  productManualFulfillmentEvents,
  productOrderAdjustments,
  productOrderRefunds,
  productShipmentEvents,
  productShipmentJobs,
  productShipments,
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
  const db = getPrivateDb();
  return db.transaction(async (tx) => {
    await markEligibleCheckoutOrdersPrivacyTerminal(tx, now);
    const result = await tx.execute<{ id: string }>(sql`
      select o.id
      from ${checkoutOrders} o
      where o.purpose = 'product'
        and (
          o.pii_redaction_due_at <= ${now}
          or (
            o.privacy_terminal_at is not null
            and o.privacy_terminal_at <= ${terminalCutoff}
          )
        )
      for update of o
    `);
    const ids = result.rows.map((row) => row.id);
    const orderScope = (redactionDueAt: SQLWrapper, orderId: SQLWrapper) =>
      ids.length
        ? sql`(${redactionDueAt} <= ${now} OR ${orderId} IN (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}))`
        : sql`${redactionDueAt} <= ${now}`;

    const independentlyDueShipments = await tx
      .select({ id: productShipments.id, orderId: productShipments.orderId })
      .from(productShipments)
      .where(
        sql`${productShipments.piiRedactionDueAt} <= ${now}
          OR (${productShipments.privacyTerminalAt} IS NOT NULL
            AND ${productShipments.privacyTerminalAt} <= ${terminalCutoff})`,
      );

    await tx
      .update(customerEmailOutbox)
      .set({
        recipientCiphertext: "[redacted]",
        recipientEmailNormalized: null,
        templateDataCiphertext: "[redacted]",
        lastError: null,
        redactedAt: now,
        updatedAt: now,
      })
      .where(
        sql`${customerEmailOutbox.redactionDueAt} <= ${now} and ${customerEmailOutbox.redactedAt} is null`,
      );
    const orderShipmentRows = ids.length
      ? await tx
          .select({
            id: productShipments.id,
            orderId: productShipments.orderId,
          })
          .from(productShipments)
          .where(inArray(productShipments.orderId, ids))
      : [];
    const shipmentIds = [
      ...new Set(
        [...independentlyDueShipments, ...orderShipmentRows].map(
          (row) => row.id,
        ),
      ),
    ];
    await tx
      .update(productShipmentEvents)
      .set({ description: null, payload: null, redactedAt: now })
      .where(
        shipmentIds.length
          ? sql`(${productShipmentEvents.piiRedactionDueAt} <= ${now}
              OR ${productShipmentEvents.shipmentId} IN (${sql.join(
                shipmentIds.map((id) => sql`${id}::uuid`),
                sql`, `,
              )}))
              AND ${productShipmentEvents.redactedAt} IS NULL`
          : sql`${productShipmentEvents.piiRedactionDueAt} <= ${now}
              AND ${productShipmentEvents.redactedAt} IS NULL`,
      );
    await tx
      .update(productShipmentJobs)
      .set({
        payload: null,
        lastError: null,
        reconciliationEvidenceReference: null,
        reconciliationRationale: null,
        reconciliationRequestedByAdminUserId: null,
        reconciliationStepUpAuthenticatedAt: null,
        reconciliationRequestedAt: null,
        redactedAt: now,
        updatedAt: now,
      })
      .where(
        shipmentIds.length
          ? sql`(${productShipmentJobs.piiRedactionDueAt} <= ${now}
              OR ${productShipmentJobs.shipmentId} IN (${sql.join(
                shipmentIds.map((id) => sql`${id}::uuid`),
                sql`, `,
              )}))
              AND ${productShipmentJobs.redactedAt} IS NULL`
          : sql`${productShipmentJobs.piiRedactionDueAt} <= ${now}
              AND ${productShipmentJobs.redactedAt} IS NULL`,
      );
    await tx
      .update(productShipments)
      .set({
        destination: REDACTED_ADDRESS,
        rates: [],
        rawShipment: null,
        quoteTokenHash: sql`'redacted:' || ${productShipments.id}::text`,
        trackingNumber: null,
        trackingUrl: null,
        manualReviewEvidenceReference: null,
        manualReviewRationale: null,
        manualReviewByAdminUserId: null,
        manualReviewStepUpAuthenticatedAt: null,
        redactedAt: now,
        updatedAt: now,
      })
      .where(
        shipmentIds.length
          ? sql`${productShipments.id} IN (${sql.join(
              shipmentIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}) AND ${productShipments.redactedAt} IS NULL`
          : sql`false`,
      );
    await tx
      .update(productOrderRefunds)
      .set({
        reason: "[redacted]",
        manualReviewEvidenceReference: null,
        manualReviewRationale: null,
        manualReviewByAdminUserId: null,
        manualReviewStepUpAuthenticatedAt: null,
        manualReviewRecordedAt: null,
        redactedAt: now,
        updatedAt: now,
      })
      .where(
        orderScope(
          productOrderRefunds.piiRedactionDueAt,
          productOrderRefunds.orderId,
        ),
      );
    await tx
      .update(orderPaymentObligations)
      .set({
        disclosureSnapshot: null,
        initializationLastError: null,
        checkoutTokenHash: sql`CASE WHEN ${orderPaymentObligations.checkoutTokenHash} IS NULL THEN NULL ELSE 'redacted:' || ${orderPaymentObligations.id}::text END`,
        secretTokenCiphertext: null,
        redactedAt: now,
        updatedAt: now,
      })
      .where(
        orderScope(
          orderPaymentObligations.piiRedactionDueAt,
          orderPaymentObligations.orderId,
        ),
      );
    const obligationRows = await tx
      .select({ id: orderPaymentObligations.id })
      .from(orderPaymentObligations)
      .where(
        orderScope(
          orderPaymentObligations.piiRedactionDueAt,
          orderPaymentObligations.orderId,
        ),
      );
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
        obligationRows.length
          ? sql`(${orderPaymentTransactions.piiRedactionDueAt} <= ${now}
              OR ${orderPaymentTransactions.obligationId} IN (${sql.join(
                obligationRows.map((row) => sql`${row.id}::uuid`),
                sql`, `,
              )}))
              AND ${orderPaymentTransactions.redactedAt} IS NULL`
          : sql`${orderPaymentTransactions.piiRedactionDueAt} <= ${now}
              AND ${orderPaymentTransactions.redactedAt} IS NULL`,
      );
    await tx
      .update(productOrderAdjustments)
      .set({ reason: "[redacted]", redactedAt: now, updatedAt: now })
      .where(
        orderScope(
          productOrderAdjustments.piiRedactionDueAt,
          productOrderAdjustments.orderId,
        ),
      );
    await tx
      .update(customerEmailOutbox)
      .set({
        recipientCiphertext: "[redacted]",
        recipientEmailNormalized: null,
        templateDataCiphertext: "[redacted]",
        lastError: null,
        redactedAt: now,
        updatedAt: now,
      })
      .where(
        ids.length ? inArray(customerEmailOutbox.orderId, ids) : sql`false`,
      );
    await tx
      .update(productManualFulfillmentEvents)
      .set({
        carrier: null,
        trackingNumber: null,
        rationale: "[redacted]",
        evidence: {},
        redactedAt: now,
      })
      .where(
        orderScope(
          productManualFulfillmentEvents.piiRedactionDueAt,
          productManualFulfillmentEvents.orderId,
        ),
      );
    await tx
      .update(checkoutOrders)
      .set({
        checkoutTokenHash: sql`'redacted:' || ${checkoutOrders.id}::text`,
        secretTokenCiphertext: "[redacted]",
        initializationError: null,
        refundOriginIpCiphertext: null,
        customerName: "[redacted]",
        customerEmail: "[redacted]",
        shippingAddress: null,
        providerMetadata: null,
        fraudRiskReasons: [],
        cancellationPolicySnapshot: null,
        usImportDisclosureSnapshot: null,
        productConfirmationEmailLastError: null,
        redactedAt: now,
        updatedAt: now,
      })
      .where(ids.length ? inArray(checkoutOrders.id, ids) : sql`false`);

    await assertShippingPiiHardCaps(tx, now);
    return (
      ids.length +
      independentlyDueShipments.filter(
        (shipment) => !shipment.orderId || !ids.includes(shipment.orderId),
      ).length
    );
  });
}

export async function markCheckoutOrderPrivacyTerminalIfEligible(input: {
  orderId: string;
  now?: Date;
}): Promise<boolean> {
  const db = getPrivateDb();
  return db.transaction(async (tx) => {
    const rows = await markEligibleCheckoutOrdersPrivacyTerminal(
      tx,
      input.now ?? new Date(),
      sql`and o.id = ${input.orderId}::uuid`,
    );
    return rows.some((row) => row.id === input.orderId);
  });
}

async function markEligibleCheckoutOrdersPrivacyTerminal(
  tx: Parameters<
    Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
  >[0],
  now: Date,
  scope: SQLWrapper = sql``,
): Promise<Array<{ id: string }>> {
  const result = await tx.execute<{ id: string }>(sql`
    update ${checkoutOrders} o
    set privacy_terminal_at = ${now}
    where o.purpose = 'product'
      and o.privacy_terminal_at is null
      and o.fulfillment_quarantined_at is null
      and o.status in ('paid', 'cancelled', 'refunded')
      and o.payment_risk_status in ('not_required', 'cleared')
      and (
        (
          o.fulfillment_mode = 'automated_shipping'
          and not exists (
            select 1 from ${productShipments} s
            where s.order_id = o.id
              and s.status not in ('delivered', 'voided', 'abandoned')
          )
          and (
            o.status in ('cancelled', 'refunded')
            or exists (
              select 1 from ${productShipments} s
              where s.order_id = o.id
                and s.status in ('delivered', 'voided', 'abandoned')
            )
          )
        )
        or (
          o.fulfillment_mode in ('manual_pickup', 'manual_shipping')
          and o.manual_fulfillment_status in ('dispatched', 'cancelled')
          and exists (
            select 1
            from ${productManualFulfillmentEvents} e
            where e.order_id = o.id
              and e.status = o.manual_fulfillment_status
              and e.occurred_at = (
                select max(latest.occurred_at)
                from ${productManualFulfillmentEvents} latest
                where latest.order_id = o.id
              )
          )
        )
      )
      and not exists (
        select 1 from ${orderPaymentObligations} p
        where p.order_id = o.id
          and (
            p.status not in ('paid', 'expired', 'superseded', 'cancelled', 'refunded')
            or p.initialization_outcome = 'outcome_unknown'
          )
      )
      and not exists (
        select 1 from ${productOrderAdjustments} a
        where a.order_id = o.id
          and a.status not in ('succeeded', 'cancelled')
      )
      and not exists (
        select 1 from ${productOrderRefunds} r
        where r.order_id = o.id and r.status <> 'succeeded'
      )
      and not exists (
        select 1
        from ${productShipmentJobs} j
        inner join ${productShipments} s on s.id = j.shipment_id
        where s.order_id = o.id and j.status <> 'succeeded'
      )
      and not exists (
        select 1 from ${customerEmailOutbox} e
        where e.order_id = o.id and e.status <> 'sent'
      )
      ${scope}
    returning o.id
  `);
  return result.rows;
}

export async function assertShippingPiiHardCaps(
  tx: Parameters<
    Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
  >[0],
  now: Date,
): Promise<void> {
  const absoluteDeadlineCutoff = new Date(now.getTime() - 30 * DAY_MS);
  const [overdueOrders] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(checkoutOrders)
    .where(
      sql`${checkoutOrders.purpose} = 'product' AND ${checkoutOrders.piiRedactionDueAt} <= ${now} AND ${checkoutOrders.redactedAt} IS NULL`,
    );
  const [overdueShipments] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(productShipments)
    .where(
      sql`${productShipments.piiRedactionDueAt} <= ${now} AND ${productShipments.redactedAt} IS NULL`,
    );
  const overdueChildren = await tx.execute<{ count: string }>(sql`
    select count(*)::text as count
    from (
      select id from ${productShipmentEvents} where pii_redaction_due_at <= ${now} and redacted_at is null
      union all select id from ${productShipmentJobs} where pii_redaction_due_at <= ${now} and redacted_at is null
      union all select id from ${productOrderRefunds} where pii_redaction_due_at <= ${now} and redacted_at is null
      union all select id from ${orderPaymentObligations} where pii_redaction_due_at <= ${now} and redacted_at is null
      union all select id from ${orderPaymentTransactions} where pii_redaction_due_at <= ${now} and redacted_at is null
      union all select id from ${productOrderAdjustments} where pii_redaction_due_at <= ${now} and redacted_at is null
      union all select id from ${productManualFulfillmentEvents} where pii_redaction_due_at <= ${now} and redacted_at is null
      union all select id from ${customerEmailOutbox} where redaction_due_at <= ${now} and redacted_at is null
    ) overdue
  `);
  if (
    Number(overdueOrders?.count ?? 0) > 0 ||
    Number(overdueShipments?.count ?? 0) > 0 ||
    Number(overdueChildren.rows[0]?.count ?? 0) > 0
  ) {
    throw new Error(
      "Unredacted product-order PII exceeds the 365-day hard cap",
    );
  }
  const absoluteViolations = await tx.execute<{ count: string }>(sql`
    select count(*)::text as count
    from (
      select id from ${checkoutOrders}
      where purpose = 'product' and pii_redaction_due_at <= ${absoluteDeadlineCutoff}
        and (redacted_at is null or customer_name <> '[redacted]' or customer_email <> '[redacted]'
          or shipping_address is not null or provider_metadata is not null or refund_origin_ip_ciphertext is not null
          or initialization_error is not null or product_confirmation_email_last_error is not null
          or checkout_token_hash not like 'redacted:%' or secret_token_ciphertext <> '[redacted]')
      union all select id from ${productShipments}
      where pii_redaction_due_at <= ${absoluteDeadlineCutoff}
        and (redacted_at is null or destination ->> 'line1' <> '[redacted]' or rates <> '[]'::jsonb
          or raw_shipment is not null or tracking_number is not null or tracking_url is not null
          or quote_token_hash not like 'redacted:%'
          or manual_review_evidence_reference is not null or manual_review_rationale is not null
          or manual_review_by_admin_user_id is not null or manual_review_step_up_authenticated_at is not null)
      union all select id from ${productShipmentEvents}
      where pii_redaction_due_at <= ${absoluteDeadlineCutoff}
        and (redacted_at is null or description is not null or payload is not null)
      union all select id from ${productShipmentJobs}
      where pii_redaction_due_at <= ${absoluteDeadlineCutoff}
        and (redacted_at is null or payload is not null or last_error is not null
          or reconciliation_evidence_reference is not null or reconciliation_rationale is not null
          or reconciliation_requested_by_admin_user_id is not null
          or reconciliation_step_up_authenticated_at is not null or reconciliation_requested_at is not null)
      union all select id from ${productOrderRefunds}
      where pii_redaction_due_at <= ${absoluteDeadlineCutoff}
        and (redacted_at is null or reason <> '[redacted]'
          or manual_review_evidence_reference is not null or manual_review_rationale is not null
          or manual_review_by_admin_user_id is not null or manual_review_step_up_authenticated_at is not null
          or manual_review_recorded_at is not null)
      union all select id from ${orderPaymentObligations}
      where pii_redaction_due_at <= ${absoluteDeadlineCutoff}
        and (redacted_at is null or disclosure_snapshot is not null or secret_token_ciphertext is not null
          or initialization_last_error is not null
          or (checkout_token_hash is not null and checkout_token_hash not like 'redacted:%'))
      union all select id from ${orderPaymentTransactions}
      where pii_redaction_due_at <= ${absoluteDeadlineCutoff}
        and (redacted_at is null or originating_ip_ciphertext is not null or avs_code is not null
          or cvv_code is not null or risk_reason_codes <> '[]'::jsonb)
      union all select id from ${productOrderAdjustments}
      where pii_redaction_due_at <= ${absoluteDeadlineCutoff}
        and (redacted_at is null or reason <> '[redacted]')
      union all select id from ${productManualFulfillmentEvents}
      where pii_redaction_due_at <= ${absoluteDeadlineCutoff}
        and (redacted_at is null or carrier is not null or tracking_number is not null
          or rationale <> '[redacted]' or evidence <> '{}'::jsonb)
      union all select id from ${customerEmailOutbox}
      where redaction_due_at <= ${absoluteDeadlineCutoff}
        and (redacted_at is null or recipient_ciphertext <> '[redacted]'
          or recipient_email_normalized is not null
          or template_data_ciphertext <> '[redacted]' or last_error is not null)
    ) violations
  `);
  if (Number(absoluteViolations.rows[0]?.count ?? 0) > 0) {
    throw new Error(
      "Recoverable product-order PII exceeds the 395-day absolute cap",
    );
  }
}
