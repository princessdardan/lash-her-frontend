import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run supplemental payment offer hash tests";

// Regression for the supplemental-offer decision hash (Blocker): the offer terms
// hash MUST stay valid after the async link-mint worker merges
// `squarePaymentLinkUrl` into the obligation's disclosure_snapshot. The mint is
// required before any payment can happen; if the link URL were part of the
// hashed terms, minting it would flip decisionTermsMatchOffer to false and make
// the supplemental offer permanently uncollectable.
const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    checkoutOrders,
    customerEmailOutbox,
    orderPaymentObligations,
    productOrderCustomerDecisions,
    shippingCustomerLinkIssuances,
  } from "./src/lib/private-db/schema.ts";
  import {
    issueShippingCustomerToken,
    hashShippingCustomerToken,
  } from "./src/lib/shipping/customer-token.ts";
  import {
    exchangeSupplementalPaymentOffer,
    getSupplementalPaymentOffer,
    isSupplementalPaymentOfferSessionAuthorized,
    issueSupplementalPaymentOfferInTransaction,
    validateSupplementalPaymentOfferBearer,
  } from "./src/lib/commerce/supplemental-payment-offers.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";
  process.env.CHECKOUT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
  process.env.SHIPPING_DECISION_TOKEN_SECRET = Buffer.alloc(32, 29).toString("base64");

  const db = getPrivateDb();
  const fixture = crypto.randomUUID();
  const linkUrl = "https://checkout.square.test/pay/" + fixture;
  let orderId;
  let obligationId;

  async function cleanup() {
    if (orderId) {
      await db.delete(customerEmailOutbox).where(eq(customerEmailOutbox.orderId, orderId));
      await db.delete(productOrderCustomerDecisions).where(eq(productOrderCustomerDecisions.orderId, orderId));
      await db.delete(shippingCustomerLinkIssuances).where(eq(shippingCustomerLinkIssuances.orderId, orderId));
      await db.delete(orderPaymentObligations).where(eq(orderPaymentObligations.orderId, orderId));
      await db.delete(checkoutOrders).where(eq(checkoutOrders.id, orderId));
    }
  }

  try {
    // A paid manual-pickup product order awaiting dispatch, with a pending
    // manual_shipping top-up obligation that carries real disclosure terms.
    const [order] = await db.insert(checkoutOrders).values({
      orderId: "lh-supplemental-offer-" + fixture,
      purpose: "product",
      status: "paid",
      customerName: "Supplemental Offer Test",
      customerEmail: "supplemental-offer-" + fixture + "@example.invalid",
      amountCents: 5000,
      merchandiseAmountCents: 5000,
      shippingAmountCents: 0,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "square",
      providerPaymentId: "sq-primary-" + fixture,
      paymentRiskStatus: "cleared",
      fulfillmentMode: "manual_pickup",
      manualFulfillmentStatus: "paid_pending_dispatch",
      paidAt: new Date(),
    }).returning({ id: checkoutOrders.id, orderId: checkoutOrders.orderId });
    orderId = order.id;

    const [obligation] = await db.insert(orderPaymentObligations).values({
      orderId: order.id,
      purpose: "manual_shipping",
      status: "pending",
      merchandiseAmountCents: 0,
      shippingAmountCents: 1200,
      taxAmountCents: 0,
      totalAmountCents: 1200,
      currency: "CAD",
      sourceWorkflow: "supplemental_offer_test",
      taxPolicyVersion: "test-tax-v1",
      policyVersion: "test-policy-v1",
      paymentProvider: "square",
      initializationStatus: "ready",
      idempotencyKey: "supplemental-offer/" + order.orderId,
      // Real disclosed terms the customer agrees to (rate + carrier).
      disclosureSnapshot: { shippingRateCents: 1200, carrier: "chitchats" },
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    }).returning({ id: orderPaymentObligations.id });
    obligationId = obligation.id;

    // Issue the offer through the real issuance path (hashes the offer terms).
    const { decisionId } = await db.transaction((tx) =>
      issueSupplementalPaymentOfferInTransaction(tx, {
        obligationId: obligation.id,
        notificationOrigin: "https://lashher.test",
      }),
    );
    assert.ok(decisionId);

    // Substitute a known bearer token for the emailed (encrypted) one so the
    // exchange/get flow can be driven directly. This only swaps the token hash;
    // the offer-terms hash under test is untouched.
    const bearerToken = issueShippingCustomerToken();
    await db.update(productOrderCustomerDecisions)
      .set({ tokenHash: hashShippingCustomerToken(bearerToken, "decision") })
      .where(eq(productOrderCustomerDecisions.id, decisionId));
    assert.equal(await validateSupplementalPaymentOfferBearer(bearerToken), true);

    // Simulate the async link-mint worker: merge squarePaymentLinkUrl into the
    // obligation's disclosure_snapshot with the same effect as
    // order-store.finalizeInitializingSquareObligation's jsonb '||' merge.
    const [beforeMint] = await db
      .select({ ds: orderPaymentObligations.disclosureSnapshot })
      .from(orderPaymentObligations)
      .where(eq(orderPaymentObligations.id, obligation.id));
    await db.update(orderPaymentObligations).set({
      providerCheckoutId: "sq-link-" + fixture,
      disclosureSnapshot: { ...beforeMint.ds, squarePaymentLinkUrl: linkUrl },
      updatedAt: new Date(),
    }).where(eq(orderPaymentObligations.id, obligation.id));

    // The bearer still exchanges AFTER the mint (the fix excludes the link URL
    // from the hashed offer terms).
    const sessionToken = await exchangeSupplementalPaymentOffer(bearerToken);
    assert.ok(sessionToken, "supplemental offer must still exchange after the link mint");

    // getSupplementalPaymentOffer resolves the offer post-mint, and surfaces the
    // minted link URL in the (unhashed) returned snapshot.
    const offer = await getSupplementalPaymentOffer(sessionToken);
    assert.ok(offer, "supplemental offer must still resolve after the link mint");
    assert.equal(offer.operationId, obligation.id);
    assert.equal(offer.amountCents, 1200);
    assert.equal(offer.disclosureSnapshot.squarePaymentLinkUrl, linkUrl);
    assert.equal(offer.disclosureSnapshot.shippingRateCents, 1200);
    assert.equal(
      await isSupplementalPaymentOfferSessionAuthorized(sessionToken, obligation.id),
      true,
    );

    // A genuine change to a REAL disclosed term (the shipping rate) still
    // invalidates the offer — the hash remains sensitive to real terms.
    const [beforeTamper] = await db
      .select({ ds: orderPaymentObligations.disclosureSnapshot })
      .from(orderPaymentObligations)
      .where(eq(orderPaymentObligations.id, obligation.id));
    await db.update(orderPaymentObligations).set({
      disclosureSnapshot: { ...beforeTamper.ds, shippingRateCents: 9999 },
      updatedAt: new Date(),
    }).where(eq(orderPaymentObligations.id, obligation.id));
    assert.equal(
      await getSupplementalPaymentOffer(sessionToken),
      null,
      "changing a real disclosed term must invalidate the offer",
    );
    assert.equal(
      await isSupplementalPaymentOfferSessionAuthorized(sessionToken, obligation.id),
      false,
    );
  } finally {
    await cleanup();
    await closePrivateDbPool();
  }
`;

test(
  "supplemental offer hash survives the Square link mint but rejects real term changes",
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
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NEXT_PUBLIC_SANITY_PROJECT_ID:
            process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ?? "3auncj84",
          NEXT_PUBLIC_SANITY_DATASET:
            process.env.NEXT_PUBLIC_SANITY_DATASET ?? "staging-2026-05-10",
          NEXT_PUBLIC_SANITY_API_VERSION:
            process.env.NEXT_PUBLIC_SANITY_API_VERSION ?? "2026-03-24",
        },
        stdio: "inherit",
      },
    );
  },
);
