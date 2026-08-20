import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run product order-creation tests";

// End-to-end coverage for createInitializingProductOrder under config-driven
// readiness. This path was previously untested, which hid two blockers where a
// config version string was written into uuid FK columns (calendar_version_id,
// intake_location_attestation_id). This test seeds a config-built quote and
// asserts an order + obligation are created with destination tax applied.
const scenario = String.raw`
  import assert from "node:assert/strict";
  import { and, eq, like } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import { checkoutOrders, orderPaymentObligations, productShipments } from "./src/lib/private-db/schema.ts";
  import { createInitializingProductOrder } from "./src/lib/commerce/order-store.ts";
  import { getProductCheckoutTermsRequirement } from "./src/lib/commerce/product-checkout-terms.ts";
  import { getShippedRefundPolicyRequirement } from "./src/lib/commerce/product-shipped-refund-policy.ts";
  import { buildConfiguredQuoteContext } from "./src/lib/shipping/configured-quote-context.ts";
  import { hashShippingQuoteToken } from "./src/lib/shipping/quote-token.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";

  const strong = "abcdefghijklmnopqrstuvwxyz0123456789";
  const key32 = Buffer.alloc(32, 7).toString("base64");
  Object.assign(process.env, {
    CHITCHATS_SHIPPING_ENABLED: "true",
    CHITCHATS_CHECKOUT_ENABLED: "true",
    SHIPPING_POLICY_ENFORCEMENT_MODE: "enforce",
    NEXT_PUBLIC_SITE_URL: "https://shop.example.invalid",
    AUTH_SECRET: strong,
    CHITCHATS_QUOTE_SIGNING_SECRET: strong,
    CHITCHATS_WORKER_CRON_SECRET: strong,
    SHIPPING_DECISION_TOKEN_SECRET: strong,
    ADDRESS_CHANGE_TOKEN_SECRET: strong,
    CRON_SECRET: strong,
    CHECKOUT_SECRET_ENCRYPTION_KEY: key32,
    CHECKOUT_PII_ENCRYPTION_KEY: key32,
    CHITCHATS_ENVIRONMENT: "staging",
    CHITCHATS_CLIENT_ID: "123456",
    CHITCHATS_ACCESS_TOKEN: "chitchats-access-token",
    CHITCHATS_REGION: "ontario_manitoba",
  });
  delete process.env.VERCEL_ENV;

  const db = getPrivateDb();
  const prefix = "lh-order-creation-" + crypto.randomUUID();
  const token = prefix + "-token";
  const fingerprint = prefix + "-fingerprint";
  const now = new Date();
  const context = buildConfiguredQuoteContext({
    destinationCountryCode: "CA",
    region: "ontario_manitoba",
    now,
  });
  const rate = {
    id: "chit_chats_canada_tracked",
    postageType: "chit_chats_canada_tracked",
    title: "Chit Chats Canada Tracked",
    signatureAvailable: false,
    signatureRequired: false,
    paymentAmountCents: 1500,
    insuranceFeeCents: 0,
    insured: true,
    tracked: true,
    raw: {},
  };

  let createdOrderId;
  try {
    const [shipment] = await db.insert(productShipments).values({
      publicReference: prefix + "-quote",
      quoteTokenHash: hashShippingQuoteToken(token),
      quoteFingerprint: fingerprint,
      status: "quoted",
      destination: {
        name: "Test Customer",
        email: "order-creation@example.invalid",
        phone: "+14165550100",
        line1: "1 Test Street",
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
      rates: [rate],
      quoteExpiresAt: new Date(now.getTime() + 15 * 60_000),
      calendarVersionId: null,
      deadlinePolicySnapshot: context,
    }).returning();

    const result = await createInitializingProductOrder({
      customerName: "Test Customer",
      customerEmail: "order-creation@example.invalid",
      cart: {
        currency: "CAD",
        checkoutMode: "automated",
        amount: 100,
        lineItems: [{
          productId: "prod-1",
          sku: "SKU-1",
          description: "Test product",
          quantity: 1,
          price: 100,
          total: 100,
        }],
      },
      shippingAddress: {
        line1: "1 Test Street",
        city: "Toronto",
        province: "ON",
        postalCode: "M5V 1A1",
        country: "Canada",
        countryCode: "CA",
      },
      shippingQuoteToken: token,
      shippingQuoteFingerprint: fingerprint,
      shippingRateId: rate.id,
      refundOriginIp: "203.0.113.7",
      termsAssent: {
        accepted: true,
        version: getProductCheckoutTermsRequirement().version,
        textHash: getProductCheckoutTermsRequirement().textHash,
        presentedAt: now,
        requestEvidence: "checkout_post:00000000-0000-4000-8000-000000000000",
      },
      refundPolicy: {
        accepted: true,
        version: getShippedRefundPolicyRequirement().version,
        textHash: getShippedRefundPolicyRequirement().textHash,
        presentedAt: now,
        requestEvidence: "checkout_post:00000000-0000-4000-8000-000000000000",
      },
    });
    createdOrderId = result.databaseId;

    // merchandise 10000 + shipping 1500 = 11500 taxable; ON HST 13% = 1495.
    assert.equal(result.merchandiseAmountCents, 10_000);
    assert.equal(result.shippingAmountCents, 1_500);
    assert.equal(result.taxAmountCents, 1_495);
    assert.equal(result.totalAmountCents, 12_995);

    const order = await db.query.checkoutOrders.findFirst({
      where: eq(checkoutOrders.id, result.databaseId),
    });
    assert.equal(order.amountCents, 12_995);
    assert.equal(order.taxAmountCents, 1_495);
    assert.equal(order.taxPolicyVersion, context.taxPolicyVersion);

    const obligation = await db.query.orderPaymentObligations.findFirst({
      where: and(
        eq(orderPaymentObligations.orderId, result.databaseId),
        eq(orderPaymentObligations.purpose, "primary"),
      ),
    });
    assert.ok(obligation, "a primary payment obligation must be created");
    assert.equal(obligation.totalAmountCents, 12_995);
    assert.equal(obligation.taxAmountCents, 1_495);

    const attached = await db.query.productShipments.findFirst({
      where: eq(productShipments.id, shipment.id),
    });
    assert.equal(attached.orderId, result.databaseId);
    assert.equal(attached.status, "payment_pending");
  } finally {
    if (createdOrderId) {
      await db.update(checkoutOrders)
        .set({ activeFulfillmentShipmentId: null })
        .where(eq(checkoutOrders.id, createdOrderId));
      await db.delete(orderPaymentObligations).where(
        eq(orderPaymentObligations.orderId, createdOrderId),
      );
    }
    await db.delete(productShipments).where(
      like(productShipments.publicReference, prefix + "%"),
    );
    if (createdOrderId) {
      await db.delete(checkoutOrders).where(eq(checkoutOrders.id, createdOrderId));
    }
    await closePrivateDbPool();
  }
`;

test(
  "createInitializingProductOrder builds a config-driven order with destination tax",
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
