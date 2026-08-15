import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run DB-backed shipment variance tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, inArray } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    checkoutOrders,
    orderPaymentObligations,
    orderPaymentTransactions,
    productShipments,
  } from "./src/lib/private-db/schema.ts";
  import { getCustomerPaidShipmentShippingContext } from "./src/lib/shipping/shipment-store.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";

  const db = getPrivateDb();
  const prefix = "lh-shipment-variance-gate-" + crypto.randomUUID();
  const shipmentIds = [];
  let orderId;
  const now = new Date();
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

  try {
    const [order] = await db.insert(checkoutOrders).values({
      orderId: prefix + "-order",
      purpose: "product",
      status: "paid",
      customerName: "Test Customer",
      customerEmail: "customer@example.invalid",
      amountCents: 1_200,
      merchandiseAmountCents: 1_000,
      shippingAmountCents: 200,
      atRiskValueCents: 1_000,
      lineItems: [],
      paymentRiskStatus: "cleared",
    }).returning();
    orderId = order.id;
    const [original] = await db.insert(productShipments).values({
      orderId: order.id,
      sequence: 0,
      purpose: "original",
      publicReference: prefix + "-original",
      quoteTokenHash: prefix + "-token-original",
      quoteFingerprint: prefix + "-fingerprint-original",
      status: "label_ready",
      destination,
      packageSnapshot,
      customsLines: [],
      rates: [],
      quotedShippingCents: 200,
      quoteExpiresAt: new Date(now.getTime() + 60_000),
    }).returning();
    const [replacement] = await db.insert(productShipments).values({
      orderId: order.id,
      sequence: 1,
      purpose: "replacement",
      supersedesShipmentId: original.id,
      publicReference: prefix + "-replacement",
      quoteTokenHash: prefix + "-token-replacement",
      quoteFingerprint: prefix + "-fingerprint-replacement",
      status: "ready_for_staff",
      destination,
      packageSnapshot,
      customsLines: [],
      rates: [],
      quotedShippingCents: 200,
      quoteExpiresAt: new Date(now.getTime() + 60_000),
    }).returning();
    shipmentIds.push(original.id, replacement.id);
    await db.update(checkoutOrders).set({ activeFulfillmentShipmentId: original.id }).where(eq(checkoutOrders.id, order.id));
    const [obligation] = await db.insert(orderPaymentObligations).values({
      orderId: order.id,
      purpose: "primary",
      status: "paid",
      merchandiseAmountCents: 1_000,
      shippingAmountCents: 200,
      taxAmountCents: 0,
      totalAmountCents: 1_200,
      sourceWorkflow: "automated_product_checkout",
      taxPolicyVersion: "tax-test",
      policyVersion: "policy-test",
      idempotencyKey: prefix + "-primary",
      paidAt: now,
    }).returning();
    const [transaction] = await db.insert(orderPaymentTransactions).values({
      obligationId: obligation.id,
      provider: "helcim",
      providerTransactionId: prefix + "-purchase",
      amountCents: 1_200,
      currency: "CAD",
      providerType: "purchase",
      providerStatus: "approved",
      riskStatus: "cleared",
      capturedAt: now,
    }).returning();

    assert.deepEqual(await getCustomerPaidShipmentShippingContext(original.id), {
      orderReference: order.orderId,
      paymentTransactionId: transaction.id,
      paidShippingCents: 200,
    });
    assert.equal(await getCustomerPaidShipmentShippingContext(replacement.id), null);
    await db.update(checkoutOrders).set({ activeFulfillmentShipmentId: replacement.id }).where(eq(checkoutOrders.id, order.id));
    assert.equal(await getCustomerPaidShipmentShippingContext(original.id), null);
    assert.equal(await getCustomerPaidShipmentShippingContext(replacement.id), null);
  } finally {
    if (orderId) {
      await db.update(checkoutOrders).set({ activeFulfillmentShipmentId: null }).where(eq(checkoutOrders.id, orderId));
      await db.delete(orderPaymentTransactions).where(
        eq(orderPaymentTransactions.providerTransactionId, prefix + "-purchase"),
      );
      await db.delete(orderPaymentObligations).where(eq(orderPaymentObligations.orderId, orderId));
    }
    if (shipmentIds.length) {
      await db.delete(productShipments).where(inArray(productShipments.id, shipmentIds));
    }
    if (orderId) await db.delete(checkoutOrders).where(eq(checkoutOrders.id, orderId));
    await closePrivateDbPool();
  }
`;

test(
  "shipping variance refunds target only the exact customer-funded active original generation",
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
