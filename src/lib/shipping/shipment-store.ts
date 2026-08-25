import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import { enqueueCustomerEmail } from "@/lib/commerce/customer-email-outbox";
import {
  checkoutOrders,
  orderPaymentObligations,
  orderPaymentTransactions,
  productOrderAdjustments,
  productOrderAddressChangeRequests,
  productOrderRefunds,
  productOrderTerminationWorkflows,
  productShipmentEvents,
  productShipmentJobs,
  productShipments,
  productShippingCases,
  shippingCalendarVersions,
  shippingPackageProfiles,
  type ProductShipmentDestinationSnapshot,
  type ProductShipmentCustomsLineSnapshot,
  type ProductShipmentPackageSnapshot,
  type ProductShipmentRateSnapshot,
  type FulfillmentProviderCertificationContractSnapshot,
} from "@/lib/private-db/schema";
import {
  hashShippingQuoteToken,
  issueShippingQuoteToken,
  parseShippingQuoteContextSnapshot,
  type ShippingQuoteContext,
} from "./quote-token";
import type { ProductShipmentStatus } from "./store-types";
import type { ShippingPackageProfile } from "./types";
import { computeShippingDeadlines } from "./policy-calendar";
import { allowedShipmentSourceStatuses } from "./status";
import { p10TerminationBlocksOrderInTransaction } from "./p10-termination";
import { sendShippingPolicyAlert } from "./policy-alerts";

export type ProductShipmentRow = typeof productShipments.$inferSelect;
export type ShipmentOperationRow = typeof productShipmentJobs.$inferSelect;
export type ShipmentOperationType = ShipmentOperationRow["type"];
export type ShipmentOperationStatus = ShipmentOperationRow["status"];
type DbTransaction = Parameters<
  Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
>[0];
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

export async function createQuoteOperation(input: {
  publicReference: string;
  quoteFingerprint: string;
  destination: ProductShipmentDestinationSnapshot;
  packageSnapshot: ProductShipmentPackageSnapshot;
  customsLines: ProductShipmentCustomsLineSnapshot[];
  expiresAt: Date;
  merchandiseValueCents: number;
  quoteContextSnapshot: ShippingQuoteContext;
  signatureRequested: boolean;
  usShippingContractSnapshot: FulfillmentProviderCertificationContractSnapshot | null;
  now?: Date;
}): Promise<{
  shipment: ProductShipmentRow;
  operation: ShipmentOperationRow;
  quoteToken: string;
  reused: boolean;
}> {
  const now = input.now ?? new Date();
  return getPrivateDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`shipping-quote:${input.quoteFingerprint}`}))`,
    );
    const reusableCandidates = await tx
      .select()
      .from(productShipments)
      .where(
        and(
          eq(productShipments.quoteFingerprint, input.quoteFingerprint),
          inArray(productShipments.status, ["quote_pending", "quoted"]),
          isNull(productShipments.orderId),
          gt(productShipments.quoteExpiresAt, now),
        ),
      )
      .orderBy(asc(productShipments.createdAt))
      .for("update")
      .limit(5);
    const reusable = reusableCandidates.find((candidate) => {
      const candidateToken = issueShippingQuoteToken(
        `${input.quoteFingerprint}:${candidate.quoteExpiresAt.toISOString()}`,
      );
      return (
        hashShippingQuoteToken(candidateToken) === candidate.quoteTokenHash
      );
    });
    if (reusable) {
      const quoteToken = issueShippingQuoteToken(
        `${input.quoteFingerprint}:${reusable.quoteExpiresAt.toISOString()}`,
      );
      const [operation] = await tx
        .select()
        .from(productShipmentJobs)
        .where(
          and(
            eq(productShipmentJobs.shipmentId, reusable.id),
            eq(productShipmentJobs.type, "create"),
          ),
        )
        .limit(1);
      if (!operation) {
        throw new Error(
          "Reusable shipping quote is missing its create operation",
        );
      }
      return { shipment: reusable, operation, quoteToken, reused: true };
    }
    const quoteToken = issueShippingQuoteToken(
      `${input.quoteFingerprint}:${input.expiresAt.toISOString()}`,
    );
    const quoteTokenHash = hashShippingQuoteToken(quoteToken);
    const [shipment] = await tx
      .insert(productShipments)
      .values({
        publicReference: input.publicReference,
        quoteTokenHash,
        quoteFingerprint: input.quoteFingerprint,
        destination: input.destination,
        packageSnapshot: input.packageSnapshot,
        customsLines: input.customsLines,
        rates: [],
        quoteExpiresAt: input.expiresAt,
        // The uuid FK column referenced attested calendar-version rows, which
        // no longer exist under config-driven policy. Change-detection now uses
        // the version string in the snapshot (deadlinePolicySnapshot).
        calendarVersionId: null,
        deadlinePolicySnapshot: input.quoteContextSnapshot as unknown as Record<
          string,
          unknown
        >,
        signatureRequested: input.signatureRequested,
        usShippingContractSnapshot: input.usShippingContractSnapshot,
        status: "quote_pending",
      })
      .returning();
    if (!shipment) throw new Error("Shipping quote draft could not be created");
    const payload = {
      merchandiseValueCents: input.merchandiseValueCents,
      signatureRequested: input.signatureRequested,
      expectedShipmentStateVersion: shipment.stateVersion,
    };
    const [operation] = await tx
      .insert(productShipmentJobs)
      .values({
        shipmentId: shipment.id,
        type: "create",
        status: "queued",
        idempotencyKey: `quote-create/${shipment.id}`,
        operationPayloadHash: hashOperationPayload(payload),
        payload,
      })
      .returning();
    if (!operation)
      throw new Error("Shipping quote operation could not be created");
    return { shipment, operation, quoteToken, reused: false };
  });
}

export async function completeQuote(input: {
  id: string;
  expectedStateVersion?: number;
  providerShipmentId: string;
  providerStatus: string;
  rates: ProductShipmentRateSnapshot[];
  rawShipment: Record<string, unknown>;
}): Promise<boolean> {
  const updated = await getPrivateDb()
    .update(productShipments)
    .set({
      providerShipmentId: input.providerShipmentId,
      providerStatus: input.providerStatus,
      rates: input.rates,
      rawShipment: input.rawShipment,
      status: "quoted",
      stateVersion: sql`${productShipments.stateVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(productShipments.id, input.id),
        eq(productShipments.status, "quote_pending"),
        ...(input.expectedStateVersion === undefined
          ? []
          : [eq(productShipments.stateVersion, input.expectedStateVersion)]),
      ),
    )
    .returning({ id: productShipments.id });
  return updated.length === 1;
}

export async function persistRefreshedProviderQuote(input: {
  id: string;
  expectedStateVersion: number;
  providerStatus: string;
  rates: ProductShipmentRateSnapshot[];
  rawShipment: Record<string, unknown>;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const updated = await getPrivateDb()
    .update(productShipments)
    .set({
      providerStatus: input.providerStatus,
      rates: input.rates,
      rawShipment: input.rawShipment,
      stateVersion: sql`${productShipments.stateVersion} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(productShipments.id, input.id),
        inArray(productShipments.status, [
          "quoted",
          "ready_for_staff",
          "purchase_pending",
        ]),
        eq(productShipments.stateVersion, input.expectedStateVersion),
      ),
    )
    .returning({ id: productShipments.id });
  return updated.length === 1;
}

export async function persistKnownProviderDraft(input: {
  id: string;
  providerShipmentId: string;
  providerStatus: string;
  rawShipment: Record<string, unknown>;
  now?: Date;
}): Promise<ProductShipmentRow | null> {
  const now = input.now ?? new Date();
  return getPrivateDb().transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(productShipments)
      .where(eq(productShipments.id, input.id))
      .for("update")
      .limit(1);
    if (!current) return null;
    if (current.providerShipmentId === input.providerShipmentId) return current;
    if (current.providerShipmentId !== null) return null;

    const [updated] = await tx
      .update(productShipments)
      .set({
        providerShipmentId: input.providerShipmentId,
        providerStatus: input.providerStatus,
        rawShipment: input.rawShipment,
        stateVersion: sql`${productShipments.stateVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(productShipments.id, input.id),
          isNull(productShipments.providerShipmentId),
          eq(productShipments.stateVersion, current.stateVersion),
        ),
      )
      .returning();
    return updated ?? null;
  });
}

export type ProviderDraftCleanupFenceResult =
  | "cleanup_enqueued"
  | "cleanup_pending"
  | "provider_already_cleaned"
  | "manual_review"
  | "fenced";

export async function fenceProviderDraftAndEnqueueCleanup(input: {
  id: string;
  providerShipmentId: string;
  allowAttached?: boolean;
  now?: Date;
}): Promise<ProviderDraftCleanupFenceResult> {
  const now = input.now ?? new Date();
  return getPrivateDb().transaction(async (tx) => {
    const [current] = await tx
      .select({
        orderId: productShipments.orderId,
        providerShipmentId: productShipments.providerShipmentId,
        status: productShipments.status,
        stateVersion: productShipments.stateVersion,
      })
      .from(productShipments)
      .where(eq(productShipments.id, input.id))
      .for("update")
      .limit(1);
    const eligibleStatus = [
      "quote_pending",
      "quoted",
      "quote_unknown",
      "abandoned",
      "manual_review",
      ...(input.allowAttached
        ? (["payment_pending", "ready_for_staff", "purchase_pending"] as const)
        : []),
    ].includes(current?.status ?? "");
    if (
      !current ||
      (!input.allowAttached && current.orderId !== null) ||
      current.providerShipmentId !== input.providerShipmentId ||
      !eligibleStatus
    ) {
      return "fenced";
    }

    const providerIdentityHash = createHash("sha256")
      .update(input.providerShipmentId)
      .digest("hex");
    const cleanupIdempotencyKey = `provider-draft-cleanup/${input.id}/${providerIdentityHash}`;
    const [existingCleanup] = await tx
      .select({ status: productShipmentJobs.status })
      .from(productShipmentJobs)
      .where(eq(productShipmentJobs.idempotencyKey, cleanupIdempotencyKey))
      .for("update")
      .limit(1);

    if (current.status === "manual_review") return "manual_review";

    if (existingCleanup?.status === "dead_letter") {
      const [manualReview] = await tx
        .update(productShipments)
        .set({
          status: "manual_review",
          manualReviewStartedAt: sql`coalesce(${productShipments.manualReviewStartedAt}, ${now})`,
          stateVersion: sql`${productShipments.stateVersion} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(productShipments.id, input.id),
            eq(productShipments.stateVersion, current.stateVersion),
          ),
        )
        .returning({ id: productShipments.id });
      return manualReview ? "manual_review" : "fenced";
    }

    let stateVersion = current.stateVersion;
    if (current.status !== "abandoned") {
      const [abandoned] = await tx
        .update(productShipments)
        .set({
          status: "abandoned",
          stateVersion: sql`${productShipments.stateVersion} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(productShipments.id, input.id),
            eq(productShipments.stateVersion, current.stateVersion),
          ),
        )
        .returning({ stateVersion: productShipments.stateVersion });
      if (!abandoned) return "fenced";
      stateVersion = abandoned.stateVersion;
    }

    if (existingCleanup?.status === "succeeded")
      return "provider_already_cleaned";
    if (
      existingCleanup &&
      ["queued", "processing", "retryable_failed"].includes(
        existingCleanup.status,
      )
    ) {
      return "cleanup_pending";
    }

    const payload = { expectedShipmentStateVersion: stateVersion };
    const [created] = await tx
      .insert(productShipmentJobs)
      .values({
        shipmentId: input.id,
        type: "cleanup",
        status: "queued",
        idempotencyKey: cleanupIdempotencyKey,
        operationPayloadHash: hashOperationPayload(payload),
        payload,
        availableAt: now,
      })
      .returning({ id: productShipmentJobs.id });
    return created ? "cleanup_enqueued" : "fenced";
  });
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

export async function markShipmentOperationManualReview(input: {
  shipmentId: string;
  expectedStateVersion?: number;
  rawShipment?: Record<string, unknown>;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const updated = await getPrivateDb()
    .update(productShipments)
    .set({
      status: "manual_review",
      manualReviewStartedAt: sql`coalesce(${productShipments.manualReviewStartedAt}, ${now})`,
      rawShipment: input.rawShipment,
      stateVersion: sql`${productShipments.stateVersion} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(productShipments.id, input.shipmentId),
        ...(input.expectedStateVersion === undefined
          ? []
          : [eq(productShipments.stateVersion, input.expectedStateVersion)]),
      ),
    )
    .returning({ id: productShipments.id });
  return updated.length === 1;
}

export async function activateShipmentForPaidOrder(
  orderId: string,
): Promise<boolean> {
  return getPrivateDb().transaction((tx) =>
    activateShipmentForPaidOrderInTransaction(tx, orderId),
  );
}

export async function activateShipmentForPaidOrderInTransaction(
  tx: DbTransaction,
  orderId: string,
  now = new Date(),
): Promise<boolean> {
  const [order] = await tx
    .select({
      id: checkoutOrders.id,
      paidAt: checkoutOrders.paidAt,
      paymentRiskStatus: checkoutOrders.paymentRiskStatus,
      activeFulfillmentShipmentId: checkoutOrders.activeFulfillmentShipmentId,
      fulfillmentClearedAt: checkoutOrders.fulfillmentClearedAt,
    })
    .from(checkoutOrders)
    .where(
      and(
        eq(checkoutOrders.orderId, orderId),
        eq(checkoutOrders.purpose, "product"),
        eq(checkoutOrders.status, "paid"),
        isNull(checkoutOrders.fulfillmentQuarantinedAt),
      ),
    )
    .for("update")
    .limit(1);
  if (!order?.activeFulfillmentShipmentId) return false;
  if (order.paymentRiskStatus !== "cleared") return false;

  const [shipment] = await tx
    .select()
    .from(productShipments)
    .where(
      and(
        eq(productShipments.id, order.activeFulfillmentShipmentId),
        eq(productShipments.orderId, order.id),
      ),
    )
    .for("update")
    .limit(1);
  if (!shipment) return false;
  if (shipment.status !== "payment_pending") {
    return [
      "ready_for_staff",
      "purchased",
      "in_transit",
      "exception",
      "delivered",
    ].includes(shipment.status);
  }
  const quoteContext = parseShippingQuoteContextSnapshot(
    shipment.deadlinePolicySnapshot,
  );
  // Config-driven policy: the frozen snapshot is authoritative for this
  // shipment's deadlines, and it is honored regardless of any later
  // source-controlled policy-version bump. Owner directive: an internal policy
  // version change must never halt or strand a paid sale — since checkout no
  // longer rejects quote→commit policy-version drift, activation must not
  // fail-closed on it either, or the order would be charged and then stranded.
  // Activation computes deadlines from the snapshot the customer was actually
  // quoted under; we require only that the snapshot is present and parseable.
  if (!quoteContext) return false;
  const frozen = quoteContext.shippingPolicySnapshot;

  const clearedAt = order.fulfillmentClearedAt ?? order.paidAt ?? now;
  const deadlines = computeShippingDeadlines({
    clearedAt,
    settings: frozen,
    closedDates: new Set(frozen.closureDates.map((entry) => entry.date)),
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
      stateVersion: sql`${productShipments.stateVersion} + 1`,
      originalHandoffDeadlineAt: deadlines.handoffDeadlineAt,
      autoRefundDeadlineAt: deadlines.autoRefundDeadlineAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(productShipments.orderId, order.id),
        eq(productShipments.status, "payment_pending"),
        eq(productShipments.id, order.activeFulfillmentShipmentId),
        eq(productShipments.stateVersion, shipment.stateVersion),
      ),
    )
    .returning({ id: productShipments.id });
  if (updated)
    await tx
      .update(checkoutOrders)
      .set({ activeFulfillmentShipmentId: updated.id, updatedAt: now })
      .where(eq(checkoutOrders.id, order.id));
  return Boolean(updated);
}

export async function getShipmentForOrderReference(
  orderReference: string,
  expected?: { shipmentId: string; stateVersion: number },
): Promise<ProductShipmentRow | null> {
  const [row] = await getPrivateDb()
    .select({ shipment: productShipments })
    .from(productShipments)
    .innerJoin(checkoutOrders, eq(productShipments.orderId, checkoutOrders.id))
    .where(
      and(
        eq(checkoutOrders.orderId, orderReference),
        eq(productShipments.id, checkoutOrders.activeFulfillmentShipmentId),
        ...(expected
          ? [
              eq(productShipments.id, expected.shipmentId),
              eq(productShipments.stateVersion, expected.stateVersion),
            ]
          : []),
      ),
    )
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
      paymentRiskStatus: checkoutOrders.paymentRiskStatus,
      activeFulfillmentShipmentId: checkoutOrders.activeFulfillmentShipmentId,
      merchandiseAmountCents: checkoutOrders.merchandiseAmountCents,
    })
    .from(checkoutOrders)
    .where(
      and(
        eq(checkoutOrders.orderId, orderReference),
        eq(checkoutOrders.status, "paid"),
        eq(checkoutOrders.purpose, "product"),
        eq(checkoutOrders.paymentRiskStatus, "cleared"),
      ),
    )
    .limit(1);
  if (!order?.activeFulfillmentShipmentId) return null;
  const [shipment] = await getPrivateDb()
    .update(productShipments)
    .set({ status: "purchase_pending", updatedAt: new Date() })
    .where(
      and(
        eq(productShipments.orderId, order.id),
        eq(productShipments.status, "ready_for_staff"),
        eq(productShipments.id, order.activeFulfillmentShipmentId),
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
  expectedStateVersion?: number;
  status: ProductShipmentStatus;
  providerStatus: string;
  rawShipment: Record<string, unknown>;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  actualPostageCents?: number | null;
  actualInsuranceCents?: number | null;
  actualPurchaseTotalCents?: number | null;
  actualDeliveryFeeCents?: number | null;
  actualTariffFeeCents?: number | null;
  actualFdaPriorNotificationFeeCents?: number | null;
  actualFederalTaxCents?: number | null;
  actualProvincialTaxCents?: number | null;
  estimatedDeliveryAt?: string | null;
  providerEventAt?: Date | null;
  providerPurchasedAt?: Date | null;
  providerShipDateAt?: Date | null;
}): Promise<boolean> {
  const now = new Date();
  const providerEventAt = input.providerEventAt ?? now;
  const purchaseVarianceCents =
    input.actualPurchaseTotalCents === undefined ||
    input.actualPurchaseTotalCents === null
      ? undefined
      : sql`${input.actualPurchaseTotalCents} - coalesce(${productShipments.quotedShippingCents}, ${input.actualPurchaseTotalCents})`;
  return getPrivateDb().transaction(async (tx) => {
    const [updated] = await tx
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
        actualPurchaseTotalCents: input.actualPurchaseTotalCents ?? undefined,
        purchaseVarianceCents,
        providerCostCurrency:
          input.actualPurchaseTotalCents === undefined ? undefined : "CAD",
        actualDeliveryFeeCents: input.actualDeliveryFeeCents ?? undefined,
        actualTariffFeeCents: input.actualTariffFeeCents ?? undefined,
        actualFdaPriorNotificationFeeCents:
          input.actualFdaPriorNotificationFeeCents ?? undefined,
        actualFederalTaxCents: input.actualFederalTaxCents ?? undefined,
        actualProvincialTaxCents: input.actualProvincialTaxCents ?? undefined,
        providerEventAt,
        providerShipDateAt: input.providerShipDateAt ?? undefined,
        stateVersion: sql`${productShipments.stateVersion} + 1`,
        lastPolledAt: now,
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
          ? sql`coalesce(${productShipments.purchasedAt}, ${input.providerPurchasedAt ?? providerEventAt})`
          : undefined,
        acceptedAt: (
          ["accepted", "in_transit", "delivered"] as ProductShipmentStatus[]
        ).includes(input.status)
          ? sql`coalesce(${productShipments.acceptedAt}, ${providerEventAt})`
          : undefined,
        deliveredAt:
          input.status === "delivered"
            ? sql`coalesce(${productShipments.deliveredAt}, ${providerEventAt})`
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
        updatedAt: now,
      })
      .where(
        and(
          eq(productShipments.id, input.id),
          inArray(
            productShipments.status,
            allowedShipmentSourceStatuses(input.status),
          ),
          or(
            isNull(productShipments.providerEventAt),
            lt(productShipments.providerEventAt, providerEventAt),
          ),
          ...(input.expectedStateVersion === undefined
            ? []
            : [eq(productShipments.stateVersion, input.expectedStateVersion)]),
        ),
      )
      .returning({ id: productShipments.id });
    if (!updated) return false;

    const notificationKind = shipmentNotificationKind(input.status);
    if (notificationKind) {
      const [context] = await tx
        .select({
          orderDatabaseId: checkoutOrders.id,
          orderReference: checkoutOrders.orderId,
          customerName: checkoutOrders.customerName,
          customerEmail: checkoutOrders.customerEmail,
          trackingNumber: productShipments.trackingNumber,
          trackingUrl: productShipments.trackingUrl,
          acceptedEmailSentAt: productShipments.acceptedEmailSentAt,
          exceptionEmailSentAt: productShipments.exceptionEmailSentAt,
          deliveredEmailSentAt: productShipments.deliveredEmailSentAt,
        })
        .from(productShipments)
        .innerJoin(
          checkoutOrders,
          eq(productShipments.orderId, checkoutOrders.id),
        )
        .where(eq(productShipments.id, input.id))
        .limit(1);
      const alreadySent =
        notificationKind === "accepted"
          ? context?.acceptedEmailSentAt
          : notificationKind === "exception"
            ? context?.exceptionEmailSentAt
            : context?.deliveredEmailSentAt;
      if (context && !alreadySent) {
        await enqueueCustomerEmail(
          {
            kind: "shipping_shipment_notification",
            orderDatabaseId: context.orderDatabaseId,
            recipient: context.customerEmail,
            providerIdempotencyKey: `product-shipment-${notificationKind}:${input.id}`,
            payload: {
              shipmentId: input.id,
              kind: notificationKind,
              orderReference: context.orderReference,
              customerName: context.customerName,
              trackingNumber: context.trackingNumber,
              trackingUrl: context.trackingUrl,
            },
            now,
          },
          tx,
        );
      }
    }
    return true;
  });
}

export async function recordUnsettledProviderAccountingEvidence(input: {
  id: string;
  expectedStateVersion: number;
  providerStatus: string;
  rawShipment: Record<string, unknown>;
  actualPostageCents?: number | null;
  actualInsuranceCents?: number | null;
  actualDeliveryFeeCents?: number | null;
  actualTariffFeeCents?: number | null;
  actualFdaPriorNotificationFeeCents?: number | null;
  actualFederalTaxCents?: number | null;
  actualProvincialTaxCents?: number | null;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const updated = await getPrivateDb()
    .update(productShipments)
    .set({
      status: "manual_review",
      providerStatus: input.providerStatus,
      rawShipment: input.rawShipment,
      actualPostageCents: input.actualPostageCents ?? undefined,
      actualInsuranceCents: input.actualInsuranceCents ?? undefined,
      actualDeliveryFeeCents: input.actualDeliveryFeeCents ?? undefined,
      actualTariffFeeCents: input.actualTariffFeeCents ?? undefined,
      actualFdaPriorNotificationFeeCents:
        input.actualFdaPriorNotificationFeeCents ?? undefined,
      actualFederalTaxCents: input.actualFederalTaxCents ?? undefined,
      actualProvincialTaxCents: input.actualProvincialTaxCents ?? undefined,
      manualReviewStartedAt: sql`coalesce(${productShipments.manualReviewStartedAt}, ${now})`,
      stateVersion: sql`${productShipments.stateVersion} + 1`,
      lastPolledAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(productShipments.id, input.id),
        eq(productShipments.stateVersion, input.expectedStateVersion),
      ),
    )
    .returning({ id: productShipments.id });
  return updated.length === 1;
}

function shipmentNotificationKind(
  status: ProductShipmentStatus,
): "accepted" | "exception" | "delivered" | null {
  if (status === "accepted" || status === "in_transit") return "accepted";
  if (status === "exception") return "exception";
  if (status === "delivered") return "delivered";
  return null;
}

export async function enqueueShipmentJob(input: {
  shipmentId: string;
  type: ShipmentOperationType;
  idempotencyKey: string;
  availableAt?: Date;
  operationPayloadHash?: string;
  payload?: Record<string, unknown>;
}): Promise<ShipmentOperationRow> {
  const operationPayloadHash =
    input.operationPayloadHash ?? hashOperationPayload(input.payload ?? {});
  const [created] = await getPrivateDb()
    .insert(productShipmentJobs)
    .values({ ...input, operationPayloadHash, status: "queued" })
    .onConflictDoNothing({ target: productShipmentJobs.idempotencyKey })
    .returning();
  if (created) return created;
  const [existing] = await getPrivateDb()
    .select()
    .from(productShipmentJobs)
    .where(eq(productShipmentJobs.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (
    !existing ||
    existing.shipmentId !== input.shipmentId ||
    existing.type !== input.type ||
    existing.operationPayloadHash !== operationPayloadHash
  ) {
    throw new Error("Shipment operation idempotency key was reused");
  }
  return existing;
}

export const enqueueShipmentOperation = enqueueShipmentJob;

export async function enqueueUnpaidProviderDraftCleanup(input: {
  source: ProductShipmentRow;
  providerShipmentId: string;
  providerStatus: string;
  publicReference: string;
  destination: ProductShipmentDestinationSnapshot;
  rawShipment: Record<string, unknown>;
  reason: string;
  now?: Date;
}): Promise<ShipmentOperationRow | null> {
  const now = input.now ?? new Date();
  return getPrivateDb().transaction(async (tx) => {
    const [created] = await tx
      .insert(productShipments)
      .values({
        orderId: null,
        sequence: 0,
        purpose: "reshipment",
        supersedesShipmentId: input.source.id,
        publicReference: input.publicReference,
        quoteTokenHash: hashShippingQuoteToken(randomUUID()),
        quoteFingerprint: `cleanup:${input.publicReference}`,
        providerShipmentId: input.providerShipmentId,
        providerStatus: input.providerStatus,
        destination: input.destination,
        packageSnapshot: input.source.packageSnapshot,
        customsLines: input.source.customsLines,
        rates: [],
        rawShipment: input.rawShipment,
        quoteExpiresAt: now,
        status: "abandoned",
        usShippingContractSnapshot: input.source.usShippingContractSnapshot,
      })
      .onConflictDoNothing({ target: productShipments.providerShipmentId })
      .returning();
    const draft =
      created ??
      (await tx.query.productShipments.findFirst({
        where: eq(
          productShipments.providerShipmentId,
          input.providerShipmentId,
        ),
      }));
    if (!draft || draft.status !== "abandoned") return null;
    const payload = {
      reason: input.reason,
      expectedShipmentStateVersion: draft.stateVersion,
    };
    const idempotencyKey = `provider-draft-cleanup/${draft.id}`;
    const [operation] = await tx
      .insert(productShipmentJobs)
      .values({
        shipmentId: draft.id,
        type: "cleanup",
        status: "queued",
        idempotencyKey,
        operationPayloadHash: hashOperationPayload(payload),
        payload,
      })
      .onConflictDoNothing({ target: productShipmentJobs.idempotencyKey })
      .returning();
    return (
      operation ??
      (await tx.query.productShipmentJobs.findFirst({
        where: eq(productShipmentJobs.idempotencyKey, idempotencyKey),
      })) ??
      null
    );
  });
}

export async function fencePreparedGenerationAndEnqueueCleanup(input: {
  shipmentId: string;
  expectedStateVersion: number;
  reason: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  return getPrivateDb().transaction(async (tx) => {
    const [shipment] = await tx
      .select()
      .from(productShipments)
      .where(eq(productShipments.id, input.shipmentId))
      .for("update")
      .limit(1);
    if (
      !shipment ||
      shipment.stateVersion !== input.expectedStateVersion ||
      !shipment.orderId ||
      !shipment.providerShipmentId ||
      !["replacement", "reshipment"].includes(shipment.purpose) ||
      !["quoted", "ready_for_staff", "manual_review"].includes(shipment.status)
    )
      return false;
    const [order] = await tx
      .select({ activeShipmentId: checkoutOrders.activeFulfillmentShipmentId })
      .from(checkoutOrders)
      .where(eq(checkoutOrders.id, shipment.orderId))
      .for("update")
      .limit(1);
    if (!order || order.activeShipmentId === shipment.id) return false;
    const [abandoned] = await tx
      .update(productShipments)
      .set({
        status: "abandoned",
        stateVersion: sql`${productShipments.stateVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(productShipments.id, shipment.id),
          eq(productShipments.stateVersion, shipment.stateVersion),
        ),
      )
      .returning({ stateVersion: productShipments.stateVersion });
    if (!abandoned) return false;
    const payload = {
      reason: input.reason,
      expectedShipmentStateVersion: abandoned.stateVersion,
    };
    const idempotencyKey = `provider-draft-cleanup/${shipment.id}`;
    const [created] = await tx
      .insert(productShipmentJobs)
      .values({
        shipmentId: shipment.id,
        type: "cleanup",
        status: "queued",
        idempotencyKey,
        operationPayloadHash: hashOperationPayload(payload),
        payload,
        availableAt: now,
      })
      .onConflictDoNothing({ target: productShipmentJobs.idempotencyKey })
      .returning({ id: productShipmentJobs.id });
    if (created) return true;
    const [existing] = await tx
      .select()
      .from(productShipmentJobs)
      .where(eq(productShipmentJobs.idempotencyKey, idempotencyKey))
      .limit(1);
    if (
      !existing ||
      existing.shipmentId !== shipment.id ||
      existing.type !== "cleanup" ||
      existing.operationPayloadHash !== hashOperationPayload(payload)
    )
      throw new Error("Prepared generation cleanup idempotency conflict");
    return true;
  });
}

export async function getShipmentOperation(
  id: string,
): Promise<ShipmentOperationRow | null> {
  const [operation] = await getPrivateDb()
    .select()
    .from(productShipmentJobs)
    .where(eq(productShipmentJobs.id, id))
    .limit(1);
  return operation ?? null;
}

export async function getShipmentOperationForOrder(input: {
  operationId: string;
  orderReference: string;
  shipmentId: string;
}): Promise<ShipmentOperationRow | null> {
  const [operation] = await getPrivateDb()
    .select({ operation: productShipmentJobs })
    .from(productShipmentJobs)
    .innerJoin(
      productShipments,
      eq(productShipmentJobs.shipmentId, productShipments.id),
    )
    .innerJoin(checkoutOrders, eq(productShipments.orderId, checkoutOrders.id))
    .where(
      and(
        eq(productShipmentJobs.id, input.operationId),
        eq(productShipmentJobs.shipmentId, input.shipmentId),
        eq(checkoutOrders.orderId, input.orderReference),
      ),
    )
    .limit(1);
  return operation?.operation ?? null;
}

export async function getQuoteOperationByToken(input: {
  operationId: string;
  quoteToken: string;
}): Promise<{
  operation: ShipmentOperationRow;
  shipment: ProductShipmentRow;
} | null> {
  const [row] = await getPrivateDb()
    .select({ operation: productShipmentJobs, shipment: productShipments })
    .from(productShipmentJobs)
    .innerJoin(
      productShipments,
      eq(productShipmentJobs.shipmentId, productShipments.id),
    )
    .where(
      and(
        eq(productShipmentJobs.id, input.operationId),
        eq(
          productShipments.quoteTokenHash,
          hashShippingQuoteToken(input.quoteToken),
        ),
        eq(productShipmentJobs.type, "create"),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function enqueuePurchaseOperationForOrder(input: {
  orderReference: string;
  shipmentId: string;
  expectedStateVersion: number;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  now?: Date;
}): Promise<ShipmentOperationRow | null> {
  const now = input.now ?? new Date();
  return getPrivateDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('lash-her:shipping-funding-controls'))`,
    );
    const existingOperation = await tx.query.productShipmentJobs.findFirst({
      where: eq(productShipmentJobs.idempotencyKey, input.idempotencyKey),
    });
    if (existingOperation) {
      const expectedPayload = {
        ...input.payload,
        expectedShipmentStateVersion:
          existingOperation.payload?.expectedShipmentStateVersion,
        expectedPurchaseAmountCents:
          existingOperation.payload?.expectedPurchaseAmountCents,
        atRiskValueCents: existingOperation.payload?.atRiskValueCents,
      };
      if (
        existingOperation.type !== "purchase" ||
        existingOperation.shipmentId !== input.shipmentId ||
        existingOperation.operationPayloadHash !==
          hashOperationPayload(expectedPayload)
      ) {
        throw new Error("Purchase operation idempotency conflict");
      }
      return existingOperation;
    }
    const [order] = await tx
      .select()
      .from(checkoutOrders)
      .where(
        and(
          eq(checkoutOrders.orderId, input.orderReference),
          eq(checkoutOrders.purpose, "product"),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !order ||
      order.status !== "paid" ||
      order.paymentRiskStatus !== "cleared" ||
      order.fulfillmentQuarantinedAt !== null ||
      order.activeFulfillmentShipmentId !== input.shipmentId
    )
      return null;
    if (
      !(await replacementRemedyAllowsPurchase(tx, {
        orderId: order.id,
        shipmentId: input.shipmentId,
      }))
    )
      return null;
    if (await p10TerminationBlocksOrderInTransaction(tx, order.id, now))
      return null;
    const [addressHold] = await tx
      .select({ id: productOrderAddressChangeRequests.id })
      .from(productOrderAddressChangeRequests)
      .where(
        and(
          eq(productOrderAddressChangeRequests.orderId, order.id),
          eq(productOrderAddressChangeRequests.shipmentId, input.shipmentId),
          inArray(productOrderAddressChangeRequests.status, [
            "submitted",
            "risk_review",
            "approved",
          ]),
        ),
      )
      .limit(1);
    if (addressHold) return null;
    // Funding gate removed: Chit Chats account balance + auto-reload prevents
    // overspend on the provider side, so label purchase is no longer gated on a
    // local funding reservation.
    const [candidateShipment] = await tx
      .select({ quotedShippingCents: productShipments.quotedShippingCents })
      .from(productShipments)
      .where(eq(productShipments.id, input.shipmentId))
      .limit(1);
    const purchaseAmountCents =
      candidateShipment?.quotedShippingCents &&
      candidateShipment.quotedShippingCents > 0
        ? candidateShipment.quotedShippingCents
        : null;
    if (purchaseAmountCents === null) return null;
    const [shipment] = await tx
      .update(productShipments)
      .set({
        status: "purchase_pending",
        stateVersion: sql`${productShipments.stateVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(productShipments.id, input.shipmentId),
          eq(productShipments.orderId, order.id),
          eq(productShipments.status, "ready_for_staff"),
          eq(productShipments.stateVersion, input.expectedStateVersion),
        ),
      )
      .returning();
    if (!shipment) return null;
    const payload = {
      ...input.payload,
      expectedShipmentStateVersion: shipment.stateVersion,
      expectedPurchaseAmountCents: purchaseAmountCents,
      atRiskValueCents:
        order.atRiskValueCents ?? order.merchandiseAmountCents ?? 0,
    };
    const payloadHash = hashOperationPayload(payload);
    const [operation] = await tx
      .insert(productShipmentJobs)
      .values({
        shipmentId: shipment.id,
        type: "purchase",
        status: "queued",
        idempotencyKey: input.idempotencyKey,
        operationPayloadHash: payloadHash,
        payload,
      })
      .onConflictDoNothing({ target: productShipmentJobs.idempotencyKey })
      .returning();
    if (operation) return operation;
    const [existing] = await tx
      .select()
      .from(productShipmentJobs)
      .where(eq(productShipmentJobs.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (
      !existing ||
      existing.shipmentId !== shipment.id ||
      existing.operationPayloadHash !== payloadHash
    )
      throw new Error("Purchase operation idempotency conflict");
    return existing;
  });
}

export async function enqueuePreparedAddressPurchaseInTransaction(
  tx: DbTransaction,
  input: {
    orderId: string;
    requestId: string;
    sourceShipmentId: string;
    preparedShipmentId: string;
    expectedPreparedStateVersion: number;
    oldPostageOutcome: "refund_confirmed" | "delete_confirmed";
    payload: Record<string, unknown>;
    now: Date;
  },
): Promise<ShipmentOperationRow | null> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('lash-her:shipping-funding-controls'))`,
  );
  const idempotencyKey = `address-prepared-purchase/${input.requestId}/${input.preparedShipmentId}`;
  const existingOperation = await tx.query.productShipmentJobs.findFirst({
    where: eq(productShipmentJobs.idempotencyKey, idempotencyKey),
  });
  if (existingOperation) {
    if (
      existingOperation.type !== "purchase" ||
      existingOperation.shipmentId !== input.preparedShipmentId ||
      existingOperation.payload?.addressRequestId !== input.requestId
    )
      throw new Error("Prepared address purchase idempotency conflict");
    return existingOperation;
  }
  const [[order], [request], [source], [prepared]] = await Promise.all([
    tx
      .select()
      .from(checkoutOrders)
      .where(eq(checkoutOrders.id, input.orderId))
      .limit(1),
    tx
      .select()
      .from(productOrderAddressChangeRequests)
      .where(eq(productOrderAddressChangeRequests.id, input.requestId))
      .limit(1),
    tx
      .select()
      .from(productShipments)
      .where(eq(productShipments.id, input.sourceShipmentId))
      .limit(1),
    tx
      .select()
      .from(productShipments)
      .where(eq(productShipments.id, input.preparedShipmentId))
      .limit(1),
  ]);
  if (
    !order ||
    order.status !== "paid" ||
    order.paymentRiskStatus !== "cleared" ||
    order.fulfillmentQuarantinedAt !== null ||
    order.activeFulfillmentShipmentId !== input.sourceShipmentId ||
    !request ||
    request.orderId !== order.id ||
    request.status !== "approved" ||
    request.expectedSourceShipmentId !== source?.id ||
    request.preparedShipmentId !== prepared?.id ||
    request.preparedShipmentStateVersion !==
      input.expectedPreparedStateVersion ||
    !source ||
    source.orderId !== order.id ||
    (input.oldPostageOutcome === "refund_confirmed"
      ? source.status !== "voided" || !source.purchasedAt
      : source.status !== "abandoned" || Boolean(source.purchasedAt)) ||
    !prepared ||
    prepared.orderId !== order.id ||
    prepared.stateVersion !== input.expectedPreparedStateVersion ||
    prepared.status !== "ready_for_staff" ||
    !prepared.quotedShippingCents ||
    prepared.quotedShippingCents <= 0
  )
    return null;
  if (await p10TerminationBlocksOrderInTransaction(tx, order.id, input.now))
    return null;

  // Funding gate removed — Chit Chats account balance + auto-reload guards spend.
  const purchaseAmountCents = prepared.quotedShippingCents;
  const [purchasePending] = await tx
    .update(productShipments)
    .set({
      status: "purchase_pending",
      stateVersion: sql`${productShipments.stateVersion} + 1`,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(productShipments.id, prepared.id),
        eq(productShipments.stateVersion, prepared.stateVersion),
        eq(productShipments.status, "ready_for_staff"),
      ),
    )
    .returning();
  if (!purchasePending) return null;
  const nextRequestStateVersion = request.stateVersion + 1;
  const payload = {
    ...input.payload,
    addressRequestId: request.id,
    expectedActiveSourceShipmentId: source.id,
    expectedAddressRequestStateVersion: nextRequestStateVersion,
    expectedShipmentStateVersion: purchasePending.stateVersion,
    expectedPurchaseAmountCents: purchaseAmountCents,
    atRiskValueCents:
      order.atRiskValueCents ?? order.merchandiseAmountCents ?? 0,
  };
  const [operation] = await tx
    .insert(productShipmentJobs)
    .values({
      shipmentId: prepared.id,
      type: "purchase",
      status: "queued",
      idempotencyKey,
      operationPayloadHash: hashOperationPayload(payload),
      payload,
    })
    .returning();
  await tx
    .update(productOrderAddressChangeRequests)
    .set({
      oldPostageOutcome: input.oldPostageOutcome,
      preparedShipmentStateVersion: purchasePending.stateVersion,
      reconciliationState: "replacement_purchase_queued",
      stateVersion: nextRequestStateVersion,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(productOrderAddressChangeRequests.id, request.id),
        eq(
          productOrderAddressChangeRequests.stateVersion,
          request.stateVersion,
        ),
      ),
    );
  return operation ?? null;
}

export async function recheckShipmentPurchaseFunding(input: {
  operationId: string;
  leaseOwner: string;
  expectedStateVersion: number;
  requiredAmountCents: number;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  if (
    !Number.isInteger(input.requiredAmountCents) ||
    input.requiredAmountCents <= 0
  )
    return false;
  return getPrivateDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('lash-her:shipping-funding-controls'))`,
    );
    const [job] = await tx
      .select()
      .from(productShipmentJobs)
      .where(
        and(
          eq(productShipmentJobs.id, input.operationId),
          eq(productShipmentJobs.type, "purchase"),
          eq(productShipmentJobs.status, "processing"),
          eq(productShipmentJobs.leaseOwner, input.leaseOwner),
          eq(productShipmentJobs.stateVersion, input.expectedStateVersion),
          gt(productShipmentJobs.leaseExpiresAt, now),
        ),
      )
      .for("update")
      .limit(1);
    if (!job) return false;
    const [executionContext] = await tx
      .select({
        orderId: checkoutOrders.id,
        orderStatus: checkoutOrders.status,
        paymentRiskStatus: checkoutOrders.paymentRiskStatus,
        activeShipmentId: checkoutOrders.activeFulfillmentShipmentId,
        fulfillmentQuarantinedAt: checkoutOrders.fulfillmentQuarantinedAt,
      })
      .from(productShipmentJobs)
      .innerJoin(
        productShipments,
        eq(productShipmentJobs.shipmentId, productShipments.id),
      )
      .innerJoin(
        checkoutOrders,
        eq(productShipments.orderId, checkoutOrders.id),
      )
      .where(eq(productShipmentJobs.id, job.id))
      .limit(1);
    if (
      !executionContext ||
      executionContext.orderStatus !== "paid" ||
      executionContext.paymentRiskStatus !== "cleared" ||
      executionContext.fulfillmentQuarantinedAt !== null
    )
      return false;
    const addressRequestId = job.payload?.addressRequestId;
    if (
      typeof addressRequestId !== "string" &&
      !(await replacementRemedyAllowsPurchase(tx, {
        orderId: executionContext.orderId,
        shipmentId: job.shipmentId,
      }))
    )
      return false;
    if (executionContext.activeShipmentId !== job.shipmentId) {
      if (typeof addressRequestId !== "string") return false;
      const [addressAuthorization] = await tx
        .select({
          activeSourceId: checkoutOrders.activeFulfillmentShipmentId,
          expectedActiveSourceId:
            productOrderAddressChangeRequests.expectedSourceShipmentId,
          oldPostageOutcome:
            productOrderAddressChangeRequests.oldPostageOutcome,
          preparedShipmentId:
            productOrderAddressChangeRequests.preparedShipmentId,
          preparedShipmentStateVersion:
            productOrderAddressChangeRequests.preparedShipmentStateVersion,
          requestStateVersion: productOrderAddressChangeRequests.stateVersion,
          sourcePurchasedAt: productShipments.purchasedAt,
          sourceStatus: productShipments.status,
          status: productOrderAddressChangeRequests.status,
        })
        .from(productOrderAddressChangeRequests)
        .innerJoin(
          checkoutOrders,
          eq(productOrderAddressChangeRequests.orderId, checkoutOrders.id),
        )
        .innerJoin(
          productShipments,
          eq(
            productOrderAddressChangeRequests.expectedSourceShipmentId,
            productShipments.id,
          ),
        )
        .where(
          and(
            eq(productOrderAddressChangeRequests.id, addressRequestId),
            eq(
              productOrderAddressChangeRequests.orderId,
              executionContext.orderId,
            ),
          ),
        )
        .limit(1);
      const sourceSafelyReconciled =
        addressAuthorization?.oldPostageOutcome === "refund_confirmed"
          ? addressAuthorization.sourceStatus === "voided" &&
            Boolean(addressAuthorization.sourcePurchasedAt)
          : addressAuthorization?.oldPostageOutcome === "delete_confirmed" &&
            addressAuthorization.sourceStatus === "abandoned" &&
            !addressAuthorization.sourcePurchasedAt;
      if (
        !addressAuthorization ||
        addressAuthorization.status !== "approved" ||
        addressAuthorization.activeSourceId !==
          addressAuthorization.expectedActiveSourceId ||
        addressAuthorization.preparedShipmentId !== job.shipmentId ||
        addressAuthorization.preparedShipmentStateVersion !==
          job.payload?.expectedShipmentStateVersion ||
        addressAuthorization.requestStateVersion !==
          job.payload?.expectedAddressRequestStateVersion ||
        !sourceSafelyReconciled
      )
        return false;
    } else {
      const [addressHold] = await tx
        .select({ id: productOrderAddressChangeRequests.id })
        .from(productOrderAddressChangeRequests)
        .where(
          and(
            eq(
              productOrderAddressChangeRequests.orderId,
              executionContext.orderId,
            ),
            eq(productOrderAddressChangeRequests.shipmentId, job.shipmentId),
            inArray(productOrderAddressChangeRequests.status, [
              "submitted",
              "risk_review",
              "approved",
            ]),
          ),
        )
        .limit(1);
      if (addressHold) return false;
    }
    // Funding gate removed — no local balance reservation. Execution-context
    // and address-authorization checks above are the purchase preconditions.
    return true;
  });
}

async function replacementRemedyAllowsPurchase(
  tx: DbTransaction,
  input: { orderId: string; shipmentId: string },
): Promise<boolean> {
  const [shipment] = await tx
    .select({
      purpose: productShipments.purpose,
      supersedesShipmentId: productShipments.supersedesShipmentId,
    })
    .from(productShipments)
    .where(
      and(
        eq(productShipments.id, input.shipmentId),
        eq(productShipments.orderId, input.orderId),
      ),
    )
    .limit(1);
  if (!shipment) return false;
  if (shipment.purpose === "original") return true;
  const [shippingCase] = await tx
    .select()
    .from(productShippingCases)
    .where(
      and(
        eq(productShippingCases.orderId, input.orderId),
        eq(productShippingCases.remedyShipmentId, input.shipmentId),
        isNull(productShippingCases.fulfillmentQuarantinedAt),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !shippingCase ||
    shippingCase.status !== "remedy_pending" ||
    shippingCase.remedyChoice !== shipment.purpose ||
    shippingCase.sourceShipmentId !== shipment.supersedesShipmentId
  )
    return false;
  const [refund] = await tx
    .select({ id: productOrderRefunds.id })
    .from(productOrderRefunds)
    .where(
      and(
        eq(productOrderRefunds.caseId, shippingCase.id),
        isNull(productOrderRefunds.fulfillmentQuarantinedAt),
      ),
    )
    .for("update")
    .limit(1);
  const [adjustment] = await tx
    .select({ id: productOrderAdjustments.id })
    .from(productOrderAdjustments)
    .where(
      and(
        eq(productOrderAdjustments.sourceCaseId, shippingCase.id),
        eq(productOrderAdjustments.direction, "refund"),
      ),
    )
    .for("update")
    .limit(1);
  return !refund && !adjustment;
}

// Funding gate removed: there is no local funding reservation to settle or
// release, so this is a vacuous success. Retained for call-site compatibility.
export async function finalizeShipmentFundingReservation(_input: {
  operationId: string;
  leaseOwner: string;
  expectedStateVersion: number;
  outcome: "settled" | "released";
  now?: Date;
}): Promise<boolean> {
  return true;
}

export async function markShipmentPurchaseProviderCallIntent(input: {
  operationId: string;
  leaseOwner: string;
  expectedStateVersion: number;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  return getPrivateDb().transaction(async (tx) => {
    const [job] = await tx
      .select({
        id: productShipmentJobs.id,
        orderId: productShipments.orderId,
      })
      .from(productShipmentJobs)
      .innerJoin(
        productShipments,
        eq(productShipmentJobs.shipmentId, productShipments.id),
      )
      .where(
        and(
          eq(productShipmentJobs.id, input.operationId),
          eq(productShipmentJobs.type, "purchase"),
          eq(productShipmentJobs.status, "processing"),
          eq(productShipmentJobs.leaseOwner, input.leaseOwner),
          eq(productShipmentJobs.stateVersion, input.expectedStateVersion),
          gt(productShipmentJobs.leaseExpiresAt, now),
        ),
      )
      .for("update")
      .limit(1);
    if (!job?.orderId) return false;
    if (await p10TerminationBlocksOrderInTransaction(tx, job.orderId, now))
      return false;
    const [updated] = await tx
      .update(productShipmentJobs)
      .set({
        outcomeCode: "purchase_provider_call_intent_recorded",
        updatedAt: now,
      })
      .where(
        and(
          eq(productShipmentJobs.id, job.id),
          eq(productShipmentJobs.status, "processing"),
          eq(productShipmentJobs.leaseOwner, input.leaseOwner),
          eq(productShipmentJobs.stateVersion, input.expectedStateVersion),
        ),
      )
      .returning({ id: productShipmentJobs.id });
    return Boolean(updated);
  });
}

export async function reconcileP10RacedShipmentPurchase(input: {
  operationId: string;
  shipmentId: string;
  providerStatus: string;
  rawShipment: Record<string, unknown>;
  outcome: "settled" | "failed" | "unknown";
  purchaseConfirmed: boolean;
  actualPurchaseTotalCents: number | null;
  actualPostageCents: number | null;
  actualInsuranceCents: number | null;
  actualDeliveryFeeCents: number | null;
  actualTariffFeeCents: number | null;
  actualFdaPriorNotificationFeeCents: number | null;
  actualFederalTaxCents: number | null;
  actualProvincialTaxCents: number | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  providerPurchasedAt?: Date | null;
  now?: Date;
}): Promise<
  "not_blocked" | "refund_queued" | "manual_review" | "failed_no_spend"
> {
  const now = input.now ?? new Date();
  return getPrivateDb().transaction(async (tx) => {
    const [context] = await tx
      .select({
        job: productShipmentJobs,
        shipment: productShipments,
        workflow: productOrderTerminationWorkflows,
      })
      .from(productShipmentJobs)
      .innerJoin(
        productShipments,
        eq(productShipmentJobs.shipmentId, productShipments.id),
      )
      .innerJoin(
        productOrderTerminationWorkflows,
        eq(productOrderTerminationWorkflows.orderId, productShipments.orderId),
      )
      .where(
        and(
          eq(productShipmentJobs.id, input.operationId),
          eq(productShipmentJobs.shipmentId, input.shipmentId),
          eq(productShipmentJobs.type, "purchase"),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !context ||
      context.workflow.status === "cancelled" ||
      (context.workflow.status === "scheduled" &&
        context.workflow.executeAt > now)
    )
      return "not_blocked";

    if (
      input.outcome === "settled" &&
      input.actualPurchaseTotalCents !== null &&
      input.actualPurchaseTotalCents > 0
    ) {
      const [shipment] = await tx
        .update(productShipments)
        .set({
          status: "refund_pending",
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
          actualPurchaseTotalCents: input.actualPurchaseTotalCents,
          actualPostageCents: input.actualPostageCents ?? undefined,
          actualInsuranceCents: input.actualInsuranceCents ?? undefined,
          actualDeliveryFeeCents: input.actualDeliveryFeeCents ?? undefined,
          actualTariffFeeCents: input.actualTariffFeeCents ?? undefined,
          actualFdaPriorNotificationFeeCents:
            input.actualFdaPriorNotificationFeeCents ?? undefined,
          actualFederalTaxCents: input.actualFederalTaxCents ?? undefined,
          actualProvincialTaxCents: input.actualProvincialTaxCents ?? undefined,
          purchaseVarianceCents: sql`${input.actualPurchaseTotalCents} - coalesce(${productShipments.quotedShippingCents}, ${input.actualPurchaseTotalCents})`,
          providerCostCurrency: "CAD",
          providerEventAt: now,
          lastPolledAt: now,
          purchasedAt: sql`coalesce(${productShipments.purchasedAt}, ${input.providerPurchasedAt ?? now})`,
          stateVersion: sql`${productShipments.stateVersion} + 1`,
          updatedAt: now,
        })
        .where(eq(productShipments.id, context.shipment.id))
        .returning({ stateVersion: productShipments.stateVersion });
      if (!shipment) return "manual_review";

      const payload = { expectedShipmentStateVersion: shipment.stateVersion };
      const operationPayloadHash = hashOperationPayload(payload);
      const idempotencyKey = `p10-postage-refund/${context.job.id}`;
      const [refund] = await tx
        .insert(productShipmentJobs)
        .values({
          shipmentId: input.shipmentId,
          type: "refund",
          status: "queued",
          idempotencyKey,
          operationPayloadHash,
          payload,
          availableAt: now,
        })
        .onConflictDoNothing({ target: productShipmentJobs.idempotencyKey })
        .returning();
      const existingRefund =
        refund ??
        (await tx.query.productShipmentJobs.findFirst({
          where: eq(productShipmentJobs.idempotencyKey, idempotencyKey),
        }));
      const refundIsDurable =
        existingRefund?.shipmentId === input.shipmentId &&
        existingRefund.type === "refund" &&
        existingRefund.operationPayloadHash === operationPayloadHash;
      if (!refundIsDurable) {
        await tx
          .update(productShipments)
          .set({
            status: "manual_review",
            manualReviewStartedAt: sql`coalesce(${productShipments.manualReviewStartedAt}, ${now})`,
            stateVersion: sql`${productShipments.stateVersion} + 1`,
            updatedAt: now,
          })
          .where(eq(productShipments.id, input.shipmentId));
      }
      await tx
        .update(productShipmentJobs)
        .set({
          status: refundIsDurable ? "succeeded" : "dead_letter",
          outcomeCode: refundIsDurable
            ? "p10_purchase_settled_refund_queued"
            : "p10_purchase_refund_manual_review",
          outcomeUnknown: !refundIsDurable,
          completedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          stateVersion: sql`${productShipmentJobs.stateVersion} + 1`,
          updatedAt: now,
        })
        .where(eq(productShipmentJobs.id, context.job.id));
      const result = refundIsDurable ? "refund_queued" : "manual_review";
      await enqueueP10PurchaseRaceAlert(tx, {
        jobId: context.job.id,
        publicReference: context.shipment.publicReference,
        result,
        now,
      });
      return result;
    }

    const failedWithoutSpend = input.outcome === "failed";
    await tx
      .update(productShipments)
      .set({
        status: failedWithoutSpend ? "abandoned" : "manual_review",
        providerStatus: input.providerStatus,
        rawShipment: input.rawShipment,
        actualPostageCents: input.actualPostageCents ?? undefined,
        actualInsuranceCents: input.actualInsuranceCents ?? undefined,
        actualDeliveryFeeCents: input.actualDeliveryFeeCents ?? undefined,
        actualTariffFeeCents: input.actualTariffFeeCents ?? undefined,
        actualFdaPriorNotificationFeeCents:
          input.actualFdaPriorNotificationFeeCents ?? undefined,
        actualFederalTaxCents: input.actualFederalTaxCents ?? undefined,
        actualProvincialTaxCents: input.actualProvincialTaxCents ?? undefined,
        providerEventAt: now,
        lastPolledAt: now,
        purchasedAt: input.purchaseConfirmed
          ? sql`coalesce(${productShipments.purchasedAt}, ${input.providerPurchasedAt ?? now})`
          : undefined,
        manualReviewStartedAt: failedWithoutSpend
          ? undefined
          : sql`coalesce(${productShipments.manualReviewStartedAt}, ${now})`,
        stateVersion: sql`${productShipments.stateVersion} + 1`,
        updatedAt: now,
      })
      .where(eq(productShipments.id, context.shipment.id));
    await tx
      .update(productShipmentJobs)
      .set({
        status: failedWithoutSpend ? "succeeded" : "dead_letter",
        outcomeCode: failedWithoutSpend
          ? "p10_purchase_failed_no_spend"
          : "p10_purchase_accounting_manual_review",
        outcomeUnknown: !failedWithoutSpend,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        stateVersion: sql`${productShipmentJobs.stateVersion} + 1`,
        updatedAt: now,
      })
      .where(eq(productShipmentJobs.id, context.job.id));
    const result = failedWithoutSpend ? "failed_no_spend" : "manual_review";
    await enqueueP10PurchaseRaceAlert(tx, {
      jobId: context.job.id,
      publicReference: context.shipment.publicReference,
      result,
      now,
    });
    return result;
  });
}

async function enqueueP10PurchaseRaceAlert(
  tx: DbTransaction,
  input: {
    jobId: string;
    publicReference: string;
    result: "refund_queued" | "manual_review" | "failed_no_spend";
    now: Date;
  },
): Promise<void> {
  await sendShippingPolicyAlert({
    duties: ["business_owner", "finance_owner", "operations_lead"],
    critical: input.result === "manual_review",
    subject: `P-10 fenced in-flight postage purchase: ${input.publicReference}`,
    message:
      input.result === "refund_queued"
        ? "The provider purchase completed after P-10 termination began. Exact settlement evidence was retained and a postage-refund operation was queued."
        : input.result === "failed_no_spend"
          ? "The provider confirmed that the fenced purchase failed without settled postage spend."
          : "The provider purchase outcome raced P-10 termination and requires manual reconciliation; funding and provider evidence were retained.",
    idempotencyKey: `shipping-p10-purchase-race/${input.jobId}/${input.result}`,
    now: input.now,
    executor: tx,
  });
}

export async function enqueueRefundOperationForOrder(input: {
  orderReference: string;
  shipmentId: string;
  expectedStateVersion: number;
  idempotencyKey: string;
  now?: Date;
}): Promise<ShipmentOperationRow | null> {
  const now = input.now ?? new Date();
  return getPrivateDb().transaction(async (tx) => {
    const existingOperation = await tx.query.productShipmentJobs.findFirst({
      where: eq(productShipmentJobs.idempotencyKey, input.idempotencyKey),
    });
    if (existingOperation) {
      const expectedPayload = {
        expectedShipmentStateVersion: input.expectedStateVersion + 1,
      };
      if (
        existingOperation.type !== "refund" ||
        existingOperation.shipmentId !== input.shipmentId ||
        existingOperation.operationPayloadHash !==
          hashOperationPayload(expectedPayload)
      )
        throw new Error("Refund operation idempotency conflict");
      return existingOperation;
    }
    const [order] = await tx
      .select()
      .from(checkoutOrders)
      .where(
        and(
          eq(checkoutOrders.orderId, input.orderReference),
          eq(checkoutOrders.purpose, "product"),
        ),
      )
      .for("update")
      .limit(1);
    if (!order || order.activeFulfillmentShipmentId !== input.shipmentId)
      return null;
    const [shipment] = await tx
      .update(productShipments)
      .set({
        status: "refund_pending",
        stateVersion: sql`${productShipments.stateVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(productShipments.id, input.shipmentId),
          eq(productShipments.orderId, order.id),
          eq(productShipments.stateVersion, input.expectedStateVersion),
          inArray(productShipments.status, ["label_ready", "exception"]),
        ),
      )
      .returning();
    if (!shipment) return null;
    const payload = { expectedShipmentStateVersion: shipment.stateVersion };
    const [operation] = await tx
      .insert(productShipmentJobs)
      .values({
        shipmentId: shipment.id,
        type: "refund",
        status: "queued",
        idempotencyKey: input.idempotencyKey,
        operationPayloadHash: hashOperationPayload(payload),
        payload,
      })
      .onConflictDoNothing({ target: productShipmentJobs.idempotencyKey })
      .returning();
    return (
      operation ??
      (await tx.query.productShipmentJobs.findFirst({
        where: eq(productShipmentJobs.idempotencyKey, input.idempotencyKey),
      })) ??
      null
    );
  });
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
        lte(
          sql`coalesce(${productShipments.lastPolledAt}, ${productShipments.createdAt})`,
          new Date(now.getTime() - 60_000),
        ),
      ),
    )
    .orderBy(
      asc(
        sql`coalesce(${productShipments.lastPolledAt}, ${productShipments.createdAt})`,
      ),
    )
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
        now.getTime() -
          (shipment.lastPolledAt ?? shipment.createdAt).getTime() >=
        (intervalMs[shipment.status] ?? 60_000),
    )
    .slice(0, limit);
}

export async function abandonExpiredQuotes(now = new Date()): Promise<number> {
  const db = getPrivateDb();
  const detachedCount = await db.transaction(async (tx) => {
    const rows = await tx
      .update(productShipments)
      .set({
        status: "abandoned",
        stateVersion: sql`${productShipments.stateVersion} + 1`,
        updatedAt: now,
      })
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
      .returning({
        id: productShipments.id,
        stateVersion: productShipments.stateVersion,
      });
    if (rows.length)
      await tx
        .insert(productShipmentJobs)
        .values(
          rows.map(({ id, stateVersion }) => ({
            shipmentId: id,
            type: "cleanup" as const,
            status: "queued" as const,
            idempotencyKey: `quote-cleanup/${id}`,
            operationPayloadHash: hashOperationPayload({
              expectedShipmentStateVersion: stateVersion,
            }),
            payload: { expectedShipmentStateVersion: stateVersion },
          })),
        )
        .onConflictDoNothing();
    return rows.length;
  });

  const attachedCandidates = await db
    .select({
      orderId: checkoutOrders.id,
      shipmentId: productShipments.id,
    })
    .from(productShipments)
    .innerJoin(checkoutOrders, eq(productShipments.orderId, checkoutOrders.id))
    .innerJoin(
      orderPaymentObligations,
      and(
        eq(orderPaymentObligations.orderId, checkoutOrders.id),
        eq(orderPaymentObligations.purpose, "primary"),
      ),
    )
    .where(
      and(
        eq(productShipments.status, "payment_pending"),
        lte(productShipments.quoteExpiresAt, now),
        eq(checkoutOrders.status, "pending"),
        eq(orderPaymentObligations.status, "pending"),
        isNotNull(orderPaymentObligations.expiresAt),
        lte(orderPaymentObligations.expiresAt, now),
      ),
    )
    .limit(100);

  let attachedCount = 0;
  for (const candidate of attachedCandidates) {
    attachedCount += await db.transaction(async (tx) => {
      const [order] = await tx
        .select({ id: checkoutOrders.id, status: checkoutOrders.status })
        .from(checkoutOrders)
        .where(eq(checkoutOrders.id, candidate.orderId))
        .for("update")
        .limit(1);
      if (!order || order.status !== "pending") return 0;
      const [obligation] = await tx
        .select({
          expiresAt: orderPaymentObligations.expiresAt,
          status: orderPaymentObligations.status,
        })
        .from(orderPaymentObligations)
        .where(
          and(
            eq(orderPaymentObligations.orderId, order.id),
            eq(orderPaymentObligations.purpose, "primary"),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !obligation ||
        obligation.status !== "pending" ||
        !obligation.expiresAt ||
        obligation.expiresAt > now
      )
        return 0;
      const [shipment] = await tx
        .select({
          quoteExpiresAt: productShipments.quoteExpiresAt,
          stateVersion: productShipments.stateVersion,
          status: productShipments.status,
        })
        .from(productShipments)
        .where(
          and(
            eq(productShipments.id, candidate.shipmentId),
            eq(productShipments.orderId, order.id),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !shipment ||
        shipment.status !== "payment_pending" ||
        shipment.quoteExpiresAt > now
      )
        return 0;
      const [abandoned] = await tx
        .update(productShipments)
        .set({
          status: "abandoned",
          stateVersion: sql`${productShipments.stateVersion} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(productShipments.id, candidate.shipmentId),
            eq(productShipments.stateVersion, shipment.stateVersion),
          ),
        )
        .returning({ stateVersion: productShipments.stateVersion });
      if (!abandoned) return 0;
      const payload = {
        expectedShipmentStateVersion: abandoned.stateVersion,
        reason: "attached_primary_quote_expired",
      };
      await tx
        .insert(productShipmentJobs)
        .values({
          shipmentId: candidate.shipmentId,
          type: "cleanup",
          status: "queued",
          idempotencyKey: `attached-quote-cleanup/${candidate.shipmentId}`,
          operationPayloadHash: hashOperationPayload(payload),
          payload,
        })
        .onConflictDoNothing({ target: productShipmentJobs.idempotencyKey });
      return 1;
    });
  }
  return detachedCount + attachedCount;
}

export async function claimShipmentOperationJobs(input: {
  workerId: string;
  now?: Date;
  limit?: number;
  types?: ShipmentOperationType[];
}): Promise<ShipmentOperationRow[]> {
  const now = input.now ?? new Date();
  const limit = Math.min(100, Math.max(1, input.limit ?? 25));
  const leaseExpiresAt = new Date(now.getTime() + 5 * 60_000);
  return getPrivateDb().transaction(async (tx) => {
    const conditions = [
      or(
        inArray(productShipmentJobs.status, ["queued", "retryable_failed"]),
        and(
          eq(productShipmentJobs.status, "processing"),
          lt(productShipmentJobs.leaseExpiresAt, now),
        ),
      ),
      lte(
        sql`coalesce(${productShipmentJobs.nextAttemptAt}, ${productShipmentJobs.availableAt})`,
        now,
      ),
    ];
    if (input.types?.length)
      conditions.push(inArray(productShipmentJobs.type, input.types));
    const candidates = await tx
      .select({ id: productShipmentJobs.id })
      .from(productShipmentJobs)
      .where(and(...conditions))
      .orderBy(
        asc(productShipmentJobs.availableAt),
        asc(productShipmentJobs.id),
      )
      .for("update", { skipLocked: true })
      .limit(limit);
    const ids = candidates.map(({ id }) => id);
    if (!ids.length) return [];
    return tx
      .update(productShipmentJobs)
      .set({
        status: "processing",
        leaseOwner: input.workerId,
        leaseExpiresAt,
        attemptCount: sql`${productShipmentJobs.attemptCount} + 1`,
        outcomeUnknown: sql`case
          when ${productShipmentJobs.status} = 'processing'
            and ${productShipmentJobs.leaseExpiresAt} < ${now}
            and ${productShipmentJobs.type} in ('create', 'quote_refresh', 'purchase', 'refund', 'delete', 'cleanup', 'replacement_prepare', 'address_replace')
          then true
          else ${productShipmentJobs.outcomeUnknown}
        end`,
        stateVersion: sql`${productShipmentJobs.stateVersion} + 1`,
        updatedAt: now,
      })
      .where(inArray(productShipmentJobs.id, ids))
      .returning();
  });
}

export async function markShipmentMutationIntent(input: {
  operationId: string;
  leaseOwner: string;
  expectedStateVersion: number;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const updated = await getPrivateDb()
    .update(productShipmentJobs)
    .set({
      outcomeCode: "provider_mutation_intent_recorded",
      updatedAt: now,
    })
    .where(
      and(
        eq(productShipmentJobs.id, input.operationId),
        eq(productShipmentJobs.status, "processing"),
        eq(productShipmentJobs.leaseOwner, input.leaseOwner),
        eq(productShipmentJobs.stateVersion, input.expectedStateVersion),
        gt(productShipmentJobs.leaseExpiresAt, now),
      ),
    )
    .returning({ id: productShipmentJobs.id });
  return updated.length === 1;
}

export async function claimCleanupJobs(now = new Date(), limit = 25) {
  return claimShipmentOperationJobs({
    workerId: `cleanup/${crypto.randomUUID()}`,
    now,
    limit,
    types: ["cleanup"],
  });
}

export async function completeShipmentJob(
  id: string,
  input: {
    outcomeCode: string;
    manualReview?: boolean;
    lastError?: string;
    leaseOwner?: string;
    expectedStateVersion?: number;
  },
): Promise<boolean> {
  const conditions = [eq(productShipmentJobs.id, id)];
  if (input.leaseOwner)
    conditions.push(
      eq(productShipmentJobs.status, "processing"),
      eq(productShipmentJobs.leaseOwner, input.leaseOwner),
    );
  if (input.expectedStateVersion !== undefined)
    conditions.push(
      eq(productShipmentJobs.stateVersion, input.expectedStateVersion),
    );
  const updated = await getPrivateDb()
    .update(productShipmentJobs)
    .set({
      status: input.manualReview ? "dead_letter" : "succeeded",
      outcomeCode: input.outcomeCode,
      // Persist the failure reason on the dead-letter path so provider
      // rejections (e.g. a Chit Chats 400 body) are visible in the DB without
      // replaying the request. Omitted on the success path so a prior error is
      // not overwritten with an empty string.
      ...(input.lastError !== undefined
        ? { lastError: input.lastError.slice(0, 1_000) }
        : {}),
      completedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(and(...conditions))
    .returning({ id: productShipmentJobs.id });
  return updated.length === 1;
}

export async function retryShipmentJob(
  id: string,
  input: {
    error: string;
    retryAfterSeconds?: number | null;
    leaseOwner?: string;
    expectedStateVersion?: number;
    attemptCount?: number;
    outcomeUnknown?: boolean;
    now?: Date;
    jitter?: number;
  },
): Promise<
  | { status: "retried"; outcomeUnknown: boolean }
  | {
      status: "dead_lettered";
      outcomeUnknown: boolean;
      fundingReservation: "retained" | "released" | "not_applicable";
    }
  | { status: "fenced" }
> {
  const now = input.now ?? new Date();
  const attemptCount = input.attemptCount ?? 1;
  const exhausted = attemptCount >= MAX_SHIPMENT_OPERATION_ATTEMPTS;
  const delaySeconds = computeShipmentRetryDelaySeconds({
    attemptCount,
    retryAfterSeconds: input.retryAfterSeconds,
    jitter: input.jitter,
  });
  return getPrivateDb().transaction(async (tx) => {
    const conditions = [eq(productShipmentJobs.id, id)];
    if (input.leaseOwner)
      conditions.push(
        eq(productShipmentJobs.status, "processing"),
        eq(productShipmentJobs.leaseOwner, input.leaseOwner),
      );
    if (input.expectedStateVersion !== undefined)
      conditions.push(
        eq(productShipmentJobs.stateVersion, input.expectedStateVersion),
      );
    const [current] = await tx
      .select()
      .from(productShipmentJobs)
      .where(and(...conditions))
      .for("update")
      .limit(1);
    if (!current) return { status: "fenced" as const };
    const outcomeUnknown = input.outcomeUnknown ?? current.outcomeUnknown;
    const [updated] = await tx
      .update(productShipmentJobs)
      .set({
        status: exhausted ? "dead_letter" : "retryable_failed",
        lastError: input.error.slice(0, 1_000),
        nextAttemptAt: exhausted
          ? null
          : new Date(now.getTime() + delaySeconds * 1_000),
        outcomeCode: exhausted ? "attempts_exhausted" : undefined,
        completedAt: exhausted ? now : undefined,
        outcomeUnknown,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(and(...conditions))
      .returning({ id: productShipmentJobs.id });
    if (!updated) return { status: "fenced" as const };
    if (!exhausted) return { status: "retried" as const, outcomeUnknown };

    await tx
      .update(productShipments)
      .set({
        status: "manual_review",
        manualReviewStartedAt: sql`coalesce(${productShipments.manualReviewStartedAt}, ${now})`,
        stateVersion: sql`${productShipments.stateVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(productShipments.id, current.shipmentId),
          sql`${productShipments.status} not in ('delivered', 'voided', 'abandoned')`,
        ),
      );
    // Funding reservations were removed; the dead-letter contract keeps the
    // field for callers but it is always "not_applicable".
    return {
      status: "dead_lettered" as const,
      outcomeUnknown,
      fundingReservation: "not_applicable" as const,
    };
  });
}

export const MAX_SHIPMENT_OPERATION_ATTEMPTS = 8;

export function computeShipmentRetryDelaySeconds(input: {
  attemptCount: number;
  retryAfterSeconds?: number | null;
  jitter?: number;
}): number {
  const attempt = Math.max(1, Math.floor(input.attemptCount));
  const exponential = Math.min(6 * 60 * 60, 30 * 2 ** (attempt - 1));
  const retryAfter = Math.max(0, input.retryAfterSeconds ?? 0);
  const jitter = Math.min(1, Math.max(0, input.jitter ?? Math.random()));
  return Math.min(
    24 * 60 * 60,
    Math.ceil(Math.max(exponential, retryAfter) * (1 + jitter * 0.25)),
  );
}

export async function requeueShipmentOperationForReconciliation(input: {
  operationId: string;
  expectedStateVersion: number;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const updated = await getPrivateDb()
    .update(productShipmentJobs)
    .set({
      status: "queued",
      availableAt: now,
      nextAttemptAt: null,
      outcomeUnknown: true,
      completedAt: null,
      outcomeCode: "manual_reconciliation_requested",
      stateVersion: sql`${productShipmentJobs.stateVersion} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(productShipmentJobs.id, input.operationId),
        eq(productShipmentJobs.status, "dead_letter"),
        eq(productShipmentJobs.stateVersion, input.expectedStateVersion),
      ),
    )
    .returning({ id: productShipmentJobs.id });
  return updated.length === 1;
}

export async function getShipmentForCleanup(id: string) {
  const [shipment] = await getPrivateDb()
    .select()
    .from(productShipments)
    .where(eq(productShipments.id, id))
    .limit(1);
  return shipment ?? null;
}

export const getShipmentForOperation = getShipmentForCleanup;

export async function adoptPreparedShipmentGeneration(input: {
  orderId: string;
  expectedActiveShipmentId: string;
  expectedActiveStateVersion: number;
  preparedShipmentId: string;
  expectedPreparedStateVersion: number;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  return getPrivateDb().transaction(async (tx) => {
    const [order] = await tx
      .select({
        id: checkoutOrders.id,
        activeShipmentId: checkoutOrders.activeFulfillmentShipmentId,
      })
      .from(checkoutOrders)
      .where(eq(checkoutOrders.id, input.orderId))
      .for("update")
      .limit(1);
    if (!order || order.activeShipmentId !== input.expectedActiveShipmentId)
      return false;
    const [source] = await tx
      .select({ stateVersion: productShipments.stateVersion })
      .from(productShipments)
      .where(
        and(
          eq(productShipments.id, input.expectedActiveShipmentId),
          eq(productShipments.orderId, order.id),
        ),
      )
      .for("update")
      .limit(1);
    const [prepared] = await tx
      .select({
        actualPurchaseTotalCents: productShipments.actualPurchaseTotalCents,
        purchasedAt: productShipments.purchasedAt,
        stateVersion: productShipments.stateVersion,
        status: productShipments.status,
      })
      .from(productShipments)
      .where(
        and(
          eq(productShipments.id, input.preparedShipmentId),
          eq(productShipments.orderId, order.id),
        ),
      )
      .for("update")
      .limit(1);
    if (
      source?.stateVersion !== input.expectedActiveStateVersion ||
      prepared?.stateVersion !== input.expectedPreparedStateVersion ||
      prepared.status !== "label_ready" ||
      !prepared.purchasedAt ||
      prepared.actualPurchaseTotalCents === null ||
      prepared.actualPurchaseTotalCents <= 0
    )
      return false;
    const [updated] = await tx
      .update(checkoutOrders)
      .set({
        activeFulfillmentShipmentId: input.preparedShipmentId,
        updatedAt: now,
      })
      .where(
        and(
          eq(checkoutOrders.id, order.id),
          eq(
            checkoutOrders.activeFulfillmentShipmentId,
            input.expectedActiveShipmentId,
          ),
        ),
      )
      .returning({ id: checkoutOrders.id });
    return Boolean(updated);
  });
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

export interface CustomerPaidShipmentShippingContext {
  orderReference: string;
  paymentTransactionId: string;
  paidShippingCents: number;
}

/**
 * Resolves the single immutable customer capture that funded an original
 * active shipment. Replacement/reshipment generations are owner-funded and
 * must never create a customer refund merely because provider cost changed.
 */
export async function getCustomerPaidShipmentShippingContext(
  shipmentId: string,
): Promise<CustomerPaidShipmentShippingContext | null> {
  const rows = await getPrivateDb()
    .select({
      orderReference: checkoutOrders.orderId,
      paymentTransactionId: orderPaymentTransactions.id,
      paidShippingCents: orderPaymentObligations.shippingAmountCents,
      quotedShippingCents: productShipments.quotedShippingCents,
    })
    .from(productShipments)
    .innerJoin(checkoutOrders, eq(productShipments.orderId, checkoutOrders.id))
    .innerJoin(
      orderPaymentObligations,
      and(
        eq(orderPaymentObligations.orderId, checkoutOrders.id),
        eq(orderPaymentObligations.purpose, "primary"),
        eq(orderPaymentObligations.status, "paid"),
        eq(
          orderPaymentObligations.sourceWorkflow,
          "automated_product_checkout",
        ),
        isNull(orderPaymentObligations.quarantinedAt),
      ),
    )
    .innerJoin(
      orderPaymentTransactions,
      and(
        eq(orderPaymentTransactions.obligationId, orderPaymentObligations.id),
        // The authoritative capture is recorded under the order's own gateway
        // (square today, helcim for historical orders).
        eq(orderPaymentTransactions.provider, checkoutOrders.paymentProvider),
        eq(orderPaymentTransactions.riskStatus, "cleared"),
      ),
    )
    .where(
      and(
        eq(productShipments.id, shipmentId),
        eq(productShipments.purpose, "original"),
        eq(productShipments.sequence, 0),
        eq(checkoutOrders.status, "paid"),
        eq(checkoutOrders.paymentRiskStatus, "cleared"),
        isNull(checkoutOrders.fulfillmentQuarantinedAt),
        eq(checkoutOrders.activeFulfillmentShipmentId, productShipments.id),
        sql`${orderPaymentObligations.shippingAmountCents} = ${productShipments.quotedShippingCents}`,
      ),
    );
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (row.paidShippingCents <= 0 || row.quotedShippingCents === null)
    return null;
  return {
    orderReference: row.orderReference,
    paymentTransactionId: row.paymentTransactionId,
    paidShippingCents: row.paidShippingCents,
  };
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
  executor: Pick<ReturnType<typeof getPrivateDb>, "update"> = getPrivateDb(),
): Promise<void> {
  const field =
    kind === "accepted"
      ? { acceptedEmailSentAt: now }
      : kind === "exception"
        ? { exceptionEmailSentAt: now }
        : { deliveredEmailSentAt: now };
  await executor
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

export function hashOperationPayload(value: unknown): string {
  return createHash("sha256").update(stableOperationJson(value)).digest("hex");
}

function stableOperationJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((entry) => stableOperationJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${stableOperationJson(entry)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
