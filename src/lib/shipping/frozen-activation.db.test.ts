import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run frozen shipping activation tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import { checkoutOrders, productShipments } from "./src/lib/private-db/schema.ts";
  import { activateShipmentForPaidOrder } from "./src/lib/shipping/shipment-store.ts";
  import { computeShippingDeadlines } from "./src/lib/shipping/policy-calendar.ts";
  import { PRODUCT_SHIPPING_POLICY_VERSION } from "./src/lib/shipping/product-shipping-config.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";

  const db = getPrivateDb();
  const prefix = "lh-frozen-activation-" + crypto.randomUUID();
  const clearedAt = new Date("2026-08-17T14:00:00.000Z");
  const originalClosures = [
    { date: "2026-08-18", kind: "branch_closure", label: "Test closure" },
  ];
  const frozenPolicy = {
    afterCutoffHandoffBusinessDays: 2,
    autoRefundBusinessDays: 2,
    beforeCutoffHandoffBusinessDays: 1,
    closureDates: originalClosures,
    coverageEndsAt: "17:00:00",
    coverageStartsAt: "09:00:00",
    orderCutoff: "14:00:00",
    signatureThresholdCents: 50_000,
    timezone: "America/Toronto",
  };
  const baseContext = (policyVersion) => ({
    helcimProductPaymentsContract: {
      contract: "helcim_product_payments",
      version: "helcim-product-payments-v1",
      evidenceReference: "test/helcim/product-payments/v1",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: "2028-01-01T00:00:00.000Z",
      purchaseTransactionTypes: ["purchase"],
      refundTransactionTypes: ["refund"],
      purchaseSuccessfulStatuses: ["approved"],
      refundSuccessfulStatuses: ["approved"],
      avs: { fieldNames: ["avsResponse"], matchCodes: ["m"], mismatchCodes: ["n"] },
      cvv: { fieldNames: ["cvvResponse"], matchCodes: ["m"], mismatchCodes: ["n"] },
      refundCorrelation: {
        providerRefundIdFields: ["transactionId"],
        originalTransactionIdFields: ["originalTransactionId"],
        merchantReferenceFields: ["merchantReference"],
      },
    },
    policyVersion,
    region: "ontario_manitoba",
    servicePolicies: [],
    shippingPolicySnapshot: frozenPolicy,
    taxPolicyApproval: {
      approvalAction: "approve_product_tax_policy",
      approvalEvidenceHash: "c".repeat(64),
      approvalEvidenceVersion: "v1",
      approvalStepUpAuthenticatedAt: "2026-08-14T11:59:00.000Z",
      approvedAt: "2026-08-14T12:00:00.000Z",
      approvedByAdminUserId: "source-controlled-config",
      coverage: { merchandise: true, shipping: true, supplements: true, usOrders: true, componentRefunds: true },
      effectiveAt: "2026-08-14T12:00:00.000Z",
      evidenceReference: "evidence/tax/v1",
      ownerName: "Configured Owner",
      version: "tax-v1",
    },
    taxPolicyVersion: "tax-v1",
    usShippingContract: null,
  });
  const destination = {
    name: "Test Customer",
    email: "customer@example.invalid",
    phone: "+14165550100",
    line1: "100 Test Street",
    city: "Toronto",
    province: "ON",
    postalCode: "M5V 1A1",
    country: "Canada",
    countryCode: "CA",
  };
  const packageSnapshot = {
    profileId: "profile",
    profileSlug: "profile",
    packageType: "parcel",
    lengthCm: 10,
    widthCm: 10,
    heightCm: 10,
    tareWeightGrams: 10,
    totalWeightGrams: 100,
  };

  const created = [];
  async function seedOrderAndShipment(suffix, policyVersion) {
    const [order] = await db.insert(checkoutOrders).values({
      orderId: prefix + suffix + "-order",
      purpose: "product",
      status: "paid",
      paidAt: clearedAt,
      fulfillmentClearedAt: clearedAt,
      customerName: "Test Customer",
      customerEmail: "customer@example.invalid",
      amountCents: 1_200,
      merchandiseAmountCents: 1_000,
      shippingAmountCents: 200,
      lineItems: [],
      paymentRiskStatus: "cleared",
      shippingPolicyVersion: policyVersion,
      taxPolicyVersion: "tax-v1",
    }).returning();
    const [shipment] = await db.insert(productShipments).values({
      orderId: order.id,
      publicReference: prefix + suffix + "-shipment",
      quoteTokenHash: prefix + suffix + "-token",
      quoteFingerprint: prefix + suffix + "-fingerprint",
      status: "payment_pending",
      destination,
      packageSnapshot,
      customsLines: [],
      rates: [],
      quoteExpiresAt: new Date("2026-08-17T15:00:00.000Z"),
      calendarVersionId: null,
      deadlinePolicySnapshot: baseContext(policyVersion),
    }).returning();
    await db.update(checkoutOrders)
      .set({ activeFulfillmentShipmentId: shipment.id })
      .where(eq(checkoutOrders.id, order.id));
    created.push({ orderId: order.id, shipmentId: shipment.id });
    return { order, shipment };
  }

  try {
    // Fail-closed when the frozen snapshot's policy version no longer matches
    // the current source-controlled config (change-detection).
    const stale = await seedOrderAndShipment("-stale", "stale-policy-version");
    assert.equal(
      await activateShipmentForPaidOrder(stale.order.orderId),
      false,
      "a shipment frozen under a superseded policy version must fail closed",
    );
    const heldStale = await db.query.productShipments.findFirst({
      where: eq(productShipments.id, stale.shipment.id),
    });
    assert.equal(heldStale.status, "payment_pending");

    // Current config version: activation succeeds and deadlines come from the
    // frozen snapshot.
    const current = await seedOrderAndShipment("-current", PRODUCT_SHIPPING_POLICY_VERSION);
    assert.equal(await activateShipmentForPaidOrder(current.order.orderId), true);
    const activated = await db.query.productShipments.findFirst({
      where: eq(productShipments.id, current.shipment.id),
    });
    const expected = computeShippingDeadlines({
      clearedAt,
      settings: frozenPolicy,
      closedDates: new Set(originalClosures.map((entry) => entry.date)),
    });
    assert.equal(activated.status, "ready_for_staff");
    assert.equal(
      activated.originalHandoffDeadlineAt.toISOString(),
      expected.handoffDeadlineAt.toISOString(),
    );
    assert.equal(
      activated.autoRefundDeadlineAt.toISOString(),
      expected.autoRefundDeadlineAt.toISOString(),
    );
  } finally {
    for (const { orderId, shipmentId } of created) {
      await db.update(checkoutOrders)
        .set({ activeFulfillmentShipmentId: null })
        .where(eq(checkoutOrders.id, orderId));
      await db.delete(productShipments).where(eq(productShipments.id, shipmentId));
      await db.delete(checkoutOrders).where(eq(checkoutOrders.id, orderId));
    }
    await closePrivateDbPool();
  }
`;

test(
  "shipment activation uses the frozen policy snapshot and fails closed on a superseded policy version",
  { skip: dbTestSkipReason },
  () => {
    execFileSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        scenario,
      ],
      { cwd: process.cwd(), env: process.env, stdio: "inherit" },
    );
  },
);
