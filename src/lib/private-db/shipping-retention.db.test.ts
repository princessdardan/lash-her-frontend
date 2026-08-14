import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run DB-backed shipping retention tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, like, sql } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import { checkoutOrders, productShipments } from "./src/lib/private-db/schema.ts";
  import { redactShippingPolicyPii } from "./src/lib/private-db/shipping-retention.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const db = getPrivateDb();
  const orderReference = "lh-remediation-retention-old";

  async function cleanup() {
    await db.execute(sql.raw(
      "DELETE FROM product_shipment_jobs WHERE shipment_id IN " +
      "(SELECT id FROM product_shipments WHERE public_reference LIKE 'lh-remediation-retention-%')",
    ));
    await db.delete(productShipments).where(
      like(productShipments.publicReference, "lh-remediation-retention-%"),
    );
    await db.delete(checkoutOrders).where(eq(checkoutOrders.orderId, orderReference));
  }

  try {
    await cleanup();
    const now = new Date("2026-08-14T16:00:00.000Z");
    const createdAt = new Date("2025-07-01T12:00:00.000Z");
    const [order] = await db.insert(checkoutOrders).values({
      orderId: orderReference,
      purpose: "product",
      status: "paid",
      customerName: "Retention Customer",
      customerEmail: "retention@example.invalid",
      amountCents: 2500,
      merchandiseAmountCents: 2000,
      shippingAmountCents: 500,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "helcim",
      paymentRiskStatus: "review_required",
      fulfillmentMode: "automated_shipping",
      createdAt,
      updatedAt: createdAt,
      redactedAt: new Date("2026-07-02T12:00:00.000Z"),
    }).returning({ id: checkoutOrders.id });

    const [shipment] = await db.insert(productShipments).values({
      orderId: order.id,
      publicReference: "lh-remediation-retention-shipment",
      quoteTokenHash: "retention-token-hash",
      quoteFingerprint: "retention-fingerprint",
      providerShipmentId: "retention-provider-shipment",
      providerStatus: "in_transit",
      status: "in_transit",
      destination: {
        name: "Retention Customer",
        email: "retention@example.invalid",
        phone: "4165550100",
        line1: "123 Private Street",
        city: "Toronto",
        province: "ON",
        postalCode: "M1M 1M1",
        country: "Canada",
        countryCode: "CA",
      },
      packageSnapshot: {
        profileId: "retention-package",
        profileSlug: "retention-package",
        packageType: "parcel",
        lengthCm: 20,
        widthCm: 15,
        heightCm: 5,
        tareWeightGrams: 50,
        totalWeightGrams: 300,
      },
      customsLines: [],
      rates: [],
      trackingNumber: "PRIVATE-TRACKING",
      trackingUrl: "https://tracking.example.invalid/private",
      rawShipment: { recipient: "Retention Customer" },
      quoteExpiresAt: new Date("2025-07-01T12:15:00.000Z"),
      createdAt,
      updatedAt: createdAt,
    }).returning({ id: productShipments.id });

    const count = await redactShippingPolicyPii(now);
    assert.equal(count, 1);

    const [redacted] = await db.select({
      destination: productShipments.destination,
      trackingNumber: productShipments.trackingNumber,
      trackingUrl: productShipments.trackingUrl,
      rawShipment: productShipments.rawShipment,
      redactedAt: productShipments.redactedAt,
    }).from(productShipments).where(eq(productShipments.id, shipment.id));
    assert.equal(redacted.destination.line1, "[redacted]");
    assert.equal(redacted.trackingNumber, null);
    assert.equal(redacted.trackingUrl, null);
    assert.equal(redacted.rawShipment, null);
    assert.ok(redacted.redactedAt instanceof Date);
  } finally {
    await cleanup();
    await closePrivateDbPool();
  }
`;

test(
  "day-365 shipping redaction is independent of checkout redacted_at",
  { skip: dbTestSkipReason },
  () => {
    execFileSync(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", "--eval", scenario],
      { cwd: process.cwd(), env: process.env, stdio: "pipe" },
    );
  },
);
