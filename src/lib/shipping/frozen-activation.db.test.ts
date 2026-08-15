import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run frozen shipping activation tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    checkoutOrders,
    fulfillmentPolicyVersions,
    productShipments,
    shippingCalendarVersions,
  } from "./src/lib/private-db/schema.ts";
  import { activateShipmentForPaidOrder } from "./src/lib/shipping/shipment-store.ts";
  import { computeShippingDeadlines } from "./src/lib/shipping/policy-calendar.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";

  const db = getPrivateDb();
  const prefix = "lh-frozen-activation-" + crypto.randomUUID();
  const policyVersion = prefix + "-policy";
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
  let orderId;
  let shipmentId;
  let calendarVersionId;

  try {
    await db.insert(fulfillmentPolicyVersions).values({
      version: policyVersion,
      status: "draft",
      ownerName: "Test Owner",
      policySnapshot: {},
    });
    const [calendar] = await db.insert(shippingCalendarVersions).values({
      version: prefix + "-calendar",
      status: "draft",
      timezone: "America/Toronto",
      coverageStartsOn: "2026-01-01",
      coverageEndsOn: "2028-12-31",
      closureDates: originalClosures,
    }).returning();
    calendarVersionId = calendar.id;
    const quoteContext = {
      calendarVersionId: calendar.id,
      fundingAttestationId: "44444444-4444-4444-8444-444444444444",
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
      intakeLocationAttestationId: "11111111-1111-4111-8111-111111111111",
      packageProfileApprovals: [],
      policyVersion,
      providerCertificationApprovals: [],
      region: "ontario_manitoba",
      servicePolicies: [],
      shippingPolicySnapshot: frozenPolicy,
      taxPolicyApproval: {
        approvalAction: "approve_product_tax_policy",
        approvalEvidenceHash: "c".repeat(64),
        approvalEvidenceVersion: "v1",
        approvalStepUpAuthenticatedAt: "2026-08-14T11:59:00.000Z",
        approvedAt: "2026-08-14T12:00:00.000Z",
        approvedByAdminUserId: "11111111-1111-4111-8111-111111111111",
        coverage: { merchandise: true, shipping: true, supplements: true, usOrders: true, componentRefunds: true },
        effectiveAt: "2026-08-14T12:00:00.000Z",
        evidenceReference: "evidence/tax/v1",
        ownerName: "Test Owner",
        version: "tax-v1",
      },
      taxPolicyVersion: "tax-v1",
      usShippingContract: null,
    };
    const [order] = await db.insert(checkoutOrders).values({
      orderId: prefix + "-order",
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
    orderId = order.id;
    const [shipment] = await db.insert(productShipments).values({
      orderId: order.id,
      publicReference: prefix + "-shipment",
      quoteTokenHash: prefix + "-token",
      quoteFingerprint: prefix + "-fingerprint",
      status: "payment_pending",
      destination: {
        name: "Test Customer",
        email: "customer@example.invalid",
        phone: "+14165550100",
        line1: "100 Test Street",
        city: "Toronto",
        province: "ON",
        postalCode: "M5V 1A1",
        country: "Canada",
        countryCode: "CA",
      },
      packageSnapshot: {
        profileId: "profile",
        profileSlug: "profile",
        packageType: "parcel",
        lengthCm: 10,
        widthCm: 10,
        heightCm: 10,
        tareWeightGrams: 10,
        totalWeightGrams: 100,
      },
      customsLines: [],
      rates: [],
      quoteExpiresAt: new Date("2026-08-17T15:00:00.000Z"),
      calendarVersionId: calendar.id,
      deadlinePolicySnapshot: quoteContext,
    }).returning();
    shipmentId = shipment.id;
    await db.update(checkoutOrders).set({
      activeFulfillmentShipmentId: shipment.id,
    }).where(eq(checkoutOrders.id, order.id));

    await db.update(shippingCalendarVersions).set({
      closureDates: [
        ...originalClosures,
        { date: "2026-08-19", kind: "branch_closure", label: "Late edit" },
      ],
    }).where(eq(shippingCalendarVersions.id, calendar.id));
    assert.equal(
      await activateShipmentForPaidOrder(order.orderId),
      false,
      "an edited frozen calendar must fail closed instead of rewriting the commitment",
    );
    const held = await db.query.productShipments.findFirst({
      where: eq(productShipments.id, shipment.id),
    });
    assert.equal(held.status, "payment_pending");

    await db.update(shippingCalendarVersions).set({
      closureDates: originalClosures,
    }).where(eq(shippingCalendarVersions.id, calendar.id));
    assert.equal(await activateShipmentForPaidOrder(order.orderId), true);
    const activated = await db.query.productShipments.findFirst({
      where: eq(productShipments.id, shipment.id),
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
    if (orderId) {
      await db.update(checkoutOrders).set({ activeFulfillmentShipmentId: null }).where(
        eq(checkoutOrders.id, orderId),
      );
    }
    if (shipmentId) {
      await db.delete(productShipments).where(eq(productShipments.id, shipmentId));
    }
    if (orderId) await db.delete(checkoutOrders).where(eq(checkoutOrders.id, orderId));
    if (calendarVersionId) {
      await db.delete(shippingCalendarVersions).where(
        eq(shippingCalendarVersions.id, calendarVersionId),
      );
    }
    await db.delete(fulfillmentPolicyVersions).where(
      eq(fulfillmentPolicyVersions.version, policyVersion),
    );
    await closePrivateDbPool();
  }
`;

test(
  "shipment activation uses the frozen policy and calendar snapshot",
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
