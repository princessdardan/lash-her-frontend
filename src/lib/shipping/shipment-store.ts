import "server-only";

import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  productShipmentEvents,
  productShipmentJobs,
  productShipments,
  shippingPackageProfiles,
  type ProductShipmentDestinationSnapshot,
  type ProductShipmentCustomsLineSnapshot,
  type ProductShipmentPackageSnapshot,
  type ProductShipmentRateSnapshot,
} from "@/lib/private-db/schema";
import { hashShippingQuoteToken } from "./quote-token";
import type { ProductShipmentStatus } from "./store-types";
import type { ShippingPackageProfile } from "./types";
import { loadShippingPolicyContext } from "./policy";
import { computeShippingDeadlines } from "./policy-calendar";

export type ProductShipmentRow = typeof productShipments.$inferSelect;
export type ShipmentPurchaseClaim = ProductShipmentRow & {
  orderAtRiskValueCents: number;
  orderCustomerEmail: string;
  orderFraudClassification: "low" | "high";
  orderFraudClearedAt: Date | null;
};

export async function listEnabledPackageProfiles(): Promise<
  ShippingPackageProfile[]
> {
  return getPrivateDb()
    .select()
    .from(shippingPackageProfiles)
    .where(eq(shippingPackageProfiles.enabled, true))
    .orderBy(asc(shippingPackageProfiles.rank));
}

export async function findReusableQuote(
  fingerprint: string,
  now = new Date(),
): Promise<ProductShipmentRow | null> {
  const [row] = await getPrivateDb()
    .select()
    .from(productShipments)
    .where(
      and(
        eq(productShipments.quoteFingerprint, fingerprint),
        eq(productShipments.status, "quoted"),
        isNull(productShipments.orderId),
        gt(productShipments.quoteExpiresAt, now),
      ),
    )
    .orderBy(asc(productShipments.createdAt))
    .limit(1);
  return row ?? null;
}

export async function createQuoteDraft(input: {
  publicReference: string;
  quoteToken: string;
  quoteFingerprint: string;
  destination: ProductShipmentDestinationSnapshot;
  packageSnapshot: ProductShipmentPackageSnapshot;
  customsLines: ProductShipmentCustomsLineSnapshot[];
  expiresAt: Date;
}): Promise<ProductShipmentRow> {
  const [row] = await getPrivateDb()
    .insert(productShipments)
    .values({
      publicReference: input.publicReference,
      quoteTokenHash: hashShippingQuoteToken(input.quoteToken),
      quoteFingerprint: input.quoteFingerprint,
      destination: input.destination,
      packageSnapshot: input.packageSnapshot,
      customsLines: input.customsLines,
      rates: [],
      quoteExpiresAt: input.expiresAt,
      status: "quote_pending",
    })
    .returning();
  return row;
}

export async function completeQuote(input: {
  id: string;
  providerShipmentId: string;
  providerStatus: string;
  rates: ProductShipmentRateSnapshot[];
  rawShipment: Record<string, unknown>;
}): Promise<void> {
  await getPrivateDb()
    .update(productShipments)
    .set({
      providerShipmentId: input.providerShipmentId,
      providerStatus: input.providerStatus,
      rates: input.rates,
      rawShipment: input.rawShipment,
      status: "quoted",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(productShipments.id, input.id),
        eq(productShipments.status, "quote_pending"),
      ),
    );
}

export async function markQuoteUnknown(
  id: string,
  rawShipment?: Record<string, unknown>,
): Promise<void> {
  await getPrivateDb()
    .update(productShipments)
    .set({
      status: "quote_unknown",
      ...(rawShipment ? { rawShipment } : {}),
      updatedAt: new Date(),
    })
    .where(eq(productShipments.id, id));
}

export async function getValidQuoteByToken(
  token: string,
  now = new Date(),
): Promise<ProductShipmentRow | null> {
  const [row] = await getPrivateDb()
    .select()
    .from(productShipments)
    .where(
      and(
        eq(productShipments.quoteTokenHash, hashShippingQuoteToken(token)),
        eq(productShipments.status, "quoted"),
        isNull(productShipments.orderId),
        gt(productShipments.quoteExpiresAt, now),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function attachQuoteToOrder(input: {
  orderDatabaseId: string;
  quoteToken: string;
  selectedRateId: string;
  expectedFingerprint: string;
}): Promise<ProductShipmentRow | null> {
  return getPrivateDb().transaction(async (tx) => {
    const [quote] = await tx
      .select()
      .from(productShipments)
      .where(
        and(
          eq(
            productShipments.quoteTokenHash,
            hashShippingQuoteToken(input.quoteToken),
          ),
          eq(productShipments.quoteFingerprint, input.expectedFingerprint),
          eq(productShipments.status, "quoted"),
          isNull(productShipments.orderId),
          gt(productShipments.quoteExpiresAt, new Date()),
        ),
      )
      .for("update")
      .limit(1);
    if (!quote) return null;
    const rate = quote.rates.find(
      (candidate) => candidate.id === input.selectedRateId,
    );
    if (!rate || !rate.insured || !rate.tracked) return null;
    const [updated] = await tx
      .update(productShipments)
      .set({
        orderId: input.orderDatabaseId,
        selectedRateId: rate.id,
        selectedPostageType: rate.postageType,
        quotedShippingCents: rate.paymentAmountCents,
        status: "payment_pending",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(productShipments.id, quote.id),
          isNull(productShipments.orderId),
        ),
      )
      .returning();
    return updated ?? null;
  });
}

export async function activateShipmentForPaidOrder(
  orderId: string,
): Promise<boolean> {
  const now = new Date();
  const policy = await loadShippingPolicyContext(now);
  return getPrivateDb().transaction(async (tx) => {
    const [order] = await tx
      .select({
        id: checkoutOrders.id,
        paidAt: checkoutOrders.paidAt,
        fraudClassification: checkoutOrders.fraudClassification,
        fraudClearedAt: checkoutOrders.fraudClearedAt,
        fulfillmentClearedAt: checkoutOrders.fulfillmentClearedAt,
      })
      .from(checkoutOrders)
      .where(
        and(
          eq(checkoutOrders.orderId, orderId),
          eq(checkoutOrders.purpose, "product"),
          eq(checkoutOrders.status, "paid"),
        ),
      )
      .for("update")
      .limit(1);
    if (!order) return false;
    const cleared =
      order.fraudClassification === "low" || order.fraudClearedAt !== null;
    if (!cleared) return false;

    const clearedAt =
      order.fulfillmentClearedAt ??
      (order.fraudClassification === "high"
        ? order.fraudClearedAt
        : order.paidAt) ??
      now;
    const deadlines = computeShippingDeadlines({
      clearedAt,
      settings: policy.settings,
      closedDates: policy.closedDates,
    });
    if (!order.fulfillmentClearedAt) {
      await tx
        .update(checkoutOrders)
        .set({ fulfillmentClearedAt: clearedAt, updatedAt: now })
        .where(eq(checkoutOrders.id, order.id));
    }
    const [updated] = await tx
      .update(productShipments)
      .set({
        status: "ready_for_staff",
        originalHandoffDeadlineAt: deadlines.handoffDeadlineAt,
        autoRefundDeadlineAt: deadlines.autoRefundDeadlineAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(productShipments.orderId, order.id),
          eq(productShipments.status, "payment_pending"),
        ),
      )
      .returning({ id: productShipments.id });
    return Boolean(updated);
  });
}

export async function getShipmentForOrderReference(
  orderReference: string,
): Promise<ProductShipmentRow | null> {
  const [row] = await getPrivateDb()
    .select({ shipment: productShipments })
    .from(productShipments)
    .innerJoin(checkoutOrders, eq(productShipments.orderId, checkoutOrders.id))
    .where(eq(checkoutOrders.orderId, orderReference))
    .limit(1);
  return row?.shipment ?? null;
}

export async function claimShipmentPurchase(
  orderReference: string,
): Promise<ShipmentPurchaseClaim | null> {
  const [order] = await getPrivateDb()
    .select({
      id: checkoutOrders.id,
      customerEmail: checkoutOrders.customerEmail,
      atRiskValueCents: checkoutOrders.atRiskValueCents,
      fraudClassification: checkoutOrders.fraudClassification,
      fraudClearedAt: checkoutOrders.fraudClearedAt,
      merchandiseAmountCents: checkoutOrders.merchandiseAmountCents,
    })
    .from(checkoutOrders)
    .where(
      and(
        eq(checkoutOrders.orderId, orderReference),
        eq(checkoutOrders.status, "paid"),
        eq(checkoutOrders.purpose, "product"),
      ),
    )
    .limit(1);
  if (!order) return null;
  const [shipment] = await getPrivateDb()
    .update(productShipments)
    .set({ status: "purchase_pending", updatedAt: new Date() })
    .where(
      and(
        eq(productShipments.orderId, order.id),
        eq(productShipments.status, "ready_for_staff"),
      ),
    )
    .returning();
  return shipment
    ? {
        ...shipment,
        orderAtRiskValueCents:
          order.atRiskValueCents ?? order.merchandiseAmountCents ?? 0,
        orderCustomerEmail: order.customerEmail,
        orderFraudClassification: order.fraudClassification,
        orderFraudClearedAt: order.fraudClearedAt,
      }
    : null;
}

export async function releaseShipmentPurchaseClaim(
  id: string,
  status: "ready_for_staff" | "manual_review",
  rawShipment?: Record<string, unknown>,
): Promise<void> {
  await getPrivateDb()
    .update(productShipments)
    .set({
      status,
      manualReviewStartedAt:
        status === "manual_review"
          ? sql`coalesce(${productShipments.manualReviewStartedAt}, now())`
          : undefined,
      ...(rawShipment ? { rawShipment } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(productShipments.id, id),
        eq(productShipments.status, "purchase_pending"),
      ),
    );
}

export async function acknowledgeShipmentManualReview(
  orderReference: string,
  now = new Date(),
): Promise<string | null> {
  const [updated] = await getPrivateDb()
    .update(productShipments)
    .set({ manualReviewAcknowledgedAt: now, updatedAt: now })
    .where(
      and(
        eq(productShipments.status, "manual_review"),
        sql`${productShipments.orderId} = (select ${checkoutOrders.id} from ${checkoutOrders} where ${checkoutOrders.orderId} = ${orderReference})`,
      ),
    )
    .returning({ id: productShipments.id });
  return updated?.id ?? null;
}

export async function claimShipmentRefund(
  orderReference: string,
): Promise<ProductShipmentRow | null> {
  const [order] = await getPrivateDb()
    .select({ id: checkoutOrders.id })
    .from(checkoutOrders)
    .where(
      and(
        eq(checkoutOrders.orderId, orderReference),
        eq(checkoutOrders.purpose, "product"),
      ),
    )
    .limit(1);
  if (!order) return null;
  const [shipment] = await getPrivateDb()
    .update(productShipments)
    .set({ status: "refund_pending", updatedAt: new Date() })
    .where(
      and(
        eq(productShipments.orderId, order.id),
        inArray(productShipments.status, ["label_ready", "exception"]),
      ),
    )
    .returning();
  return shipment ?? null;
}

export async function updateShipmentFromProvider(input: {
  id: string;
  status: ProductShipmentStatus;
  providerStatus: string;
  rawShipment: Record<string, unknown>;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  actualPostageCents?: number | null;
  actualInsuranceCents?: number | null;
  estimatedDeliveryAt?: string | null;
}): Promise<void> {
  await getPrivateDb()
    .update(productShipments)
    .set({
      status: input.status,
      providerStatus: input.providerStatus,
      rawShipment: input.rawShipment,
      trackingNumber:
        input.trackingNumber === undefined
          ? undefined
          : sanitizeTrackingNumber(input.trackingNumber),
      trackingUrl:
        input.trackingUrl === undefined
          ? undefined
          : sanitizeTrackingUrl(input.trackingUrl),
      actualPostageCents: input.actualPostageCents ?? undefined,
      actualInsuranceCents: input.actualInsuranceCents ?? undefined,
      latestEstimatedDeliveryAt:
        input.estimatedDeliveryAt === undefined
          ? undefined
          : parseProviderDate(input.estimatedDeliveryAt),
      purchasedAt: (
        [
          "label_ready",
          "accepted",
          "in_transit",
          "delivered",
        ] as ProductShipmentStatus[]
      ).includes(input.status)
        ? sql`coalesce(${productShipments.purchasedAt}, now())`
        : undefined,
      acceptedAt: (
        ["accepted", "in_transit", "delivered"] as ProductShipmentStatus[]
      ).includes(input.status)
        ? sql`coalesce(${productShipments.acceptedAt}, now())`
        : undefined,
      deliveredAt:
        input.status === "delivered"
          ? sql`coalesce(${productShipments.deliveredAt}, now())`
          : undefined,
      privacyTerminalAt: (
        ["delivered", "voided"] as ProductShipmentStatus[]
      ).includes(input.status)
        ? sql`coalesce(${productShipments.privacyTerminalAt}, now())`
        : undefined,
      manualReviewStartedAt:
        input.status === "manual_review"
          ? sql`coalesce(${productShipments.manualReviewStartedAt}, now())`
          : undefined,
      updatedAt: new Date(),
    })
    .where(eq(productShipments.id, input.id));
}

export async function enqueueShipmentJob(input: {
  shipmentId: string;
  type:
    | "create"
    | "purchase"
    | "tracking"
    | "refund"
    | "cleanup"
    | "notification";
  idempotencyKey: string;
  availableAt?: Date;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await getPrivateDb()
    .insert(productShipmentJobs)
    .values({ ...input, status: "queued" })
    .onConflictDoNothing({ target: productShipmentJobs.idempotencyKey });
}

export async function recordShipmentEvent(input: {
  shipmentId: string;
  fingerprint: string;
  providerStatus?: string;
  normalizedStatus: ProductShipmentStatus;
  description?: string;
  payload?: Record<string, unknown>;
  occurredAt: Date;
}): Promise<boolean> {
  const [created] = await getPrivateDb()
    .insert(productShipmentEvents)
    .values(input)
    .onConflictDoNothing({ target: productShipmentEvents.fingerprint })
    .returning({ id: productShipmentEvents.id });
  if (created)
    await getPrivateDb()
      .update(productShipments)
      .set({
        lastCarrierMovementAt: sql`greatest(coalesce(${productShipments.lastCarrierMovementAt}, ${input.occurredAt}), ${input.occurredAt})`,
      })
      .where(eq(productShipments.id, input.shipmentId));
  return Boolean(created);
}

export async function listShipmentsDueForPolling(
  now = new Date(),
  limit = 100,
): Promise<ProductShipmentRow[]> {
  const candidates = await getPrivateDb()
    .select()
    .from(productShipments)
    .where(
      and(
        inArray(productShipments.status, [
          "purchase_pending",
          "label_ready",
          "accepted",
          "in_transit",
          "exception",
          "refund_pending",
        ]),
        lte(productShipments.updatedAt, new Date(now.getTime() - 60_000)),
      ),
    )
    .orderBy(asc(productShipments.updatedAt))
    .limit(limit * 2);
  const intervalMs: Partial<Record<ProductShipmentStatus, number>> = {
    purchase_pending: 60_000,
    label_ready: 30 * 60_000,
    accepted: 2 * 60 * 60_000,
    in_transit: 2 * 60 * 60_000,
    exception: 6 * 60 * 60_000,
    refund_pending: 6 * 60 * 60_000,
  };
  return candidates
    .filter(
      (shipment) =>
        now.getTime() - shipment.updatedAt.getTime() >=
        (intervalMs[shipment.status] ?? 60_000),
    )
    .slice(0, limit);
}

export async function abandonExpiredQuotes(now = new Date()): Promise<number> {
  const rows = await getPrivateDb()
    .update(productShipments)
    .set({ status: "abandoned", updatedAt: now })
    .where(
      and(
        isNull(productShipments.orderId),
        inArray(productShipments.status, [
          "quoted",
          "quote_pending",
          "quote_unknown",
        ]),
        lte(productShipments.quoteExpiresAt, now),
      ),
    )
    .returning({ id: productShipments.id });
  return rows.length;
}

export async function redactExpiredShipmentPii(
  now = new Date(),
): Promise<number> {
  const quoteCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
  const rows = await getPrivateDb()
    .update(productShipments)
    .set({
      destination: {
        line1: "[redacted]",
        city: "[redacted]",
        province: "--",
        postalCode: "[redacted]",
        country: "[redacted]",
      },
      customsLines: [],
      rates: [],
      rawShipment: null,
      quoteTokenHash: sql`'redacted:' || ${productShipments.id}::text`,
      trackingUrl: null,
      redactedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        isNull(productShipments.redactedAt),
        or(
          and(
            eq(productShipments.status, "abandoned"),
            lte(productShipments.updatedAt, quoteCutoff),
          ),
          and(
            inArray(productShipments.status, ["delivered", "voided"]),
            sql`exists (select 1 from ${checkoutOrders} where ${checkoutOrders.id} = ${productShipments.orderId} and ${checkoutOrders.redactedAt} is not null)`,
          ),
        ),
      ),
    )
    .returning({ id: productShipments.id });
  return rows.length;
}

export interface ShipmentNotificationContext {
  shipmentId: string;
  orderId: string;
  customerName: string;
  customerEmail: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  acceptedEmailSentAt: Date | null;
  exceptionEmailSentAt: Date | null;
  deliveredEmailSentAt: Date | null;
}

export async function getShipmentNotificationContext(
  shipmentId: string,
): Promise<ShipmentNotificationContext | null> {
  const [row] = await getPrivateDb()
    .select({
      shipmentId: productShipments.id,
      orderId: checkoutOrders.orderId,
      customerName: checkoutOrders.customerName,
      customerEmail: checkoutOrders.customerEmail,
      trackingNumber: productShipments.trackingNumber,
      trackingUrl: productShipments.trackingUrl,
      acceptedEmailSentAt: productShipments.acceptedEmailSentAt,
      exceptionEmailSentAt: productShipments.exceptionEmailSentAt,
      deliveredEmailSentAt: productShipments.deliveredEmailSentAt,
    })
    .from(productShipments)
    .innerJoin(checkoutOrders, eq(productShipments.orderId, checkoutOrders.id))
    .where(eq(productShipments.id, shipmentId))
    .limit(1);
  return row ?? null;
}

export async function markShipmentNotificationSent(
  shipmentId: string,
  kind: "accepted" | "exception" | "delivered",
  now = new Date(),
): Promise<void> {
  const field =
    kind === "accepted"
      ? { acceptedEmailSentAt: now }
      : kind === "exception"
        ? { exceptionEmailSentAt: now }
        : { deliveredEmailSentAt: now };
  await getPrivateDb()
    .update(productShipments)
    .set({ ...field, updatedAt: now })
    .where(eq(productShipments.id, shipmentId));
}

function sanitizeTrackingNumber(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  return normalized && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized.slice(0, 200)
    : null;
}

function sanitizeTrackingUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function parseProviderDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
