import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run DB-backed shipment operation tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, inArray } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    checkoutOrders,
    orderPaymentObligations,
    productShipmentJobs,
    productShipments,
  } from "./src/lib/private-db/schema.ts";
  import {
    adoptPreparedShipmentGeneration,
    abandonExpiredQuotes,
    claimShipmentOperationJobs,
    completeShipmentJob,
    enqueueRefundOperationForOrder,
    enqueueShipmentOperation,
  } from "./src/lib/shipping/shipment-store.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";
  process.env.CHITCHATS_ACCESS_TOKEN = "shipment-operation-test-token";
  process.env.CHITCHATS_CLIENT_ID = "shipment-operation-test-client";
  process.env.CHITCHATS_ENVIRONMENT = "staging";
  process.env.CHITCHATS_QUOTE_SIGNING_SECRET = "shipment-operation-test-signing-secret-32-bytes";

  const db = getPrivateDb();
  const prefix = "lh-shipment-operation-db-test-";
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

  async function cleanup() {
    const rows = await db.select({ id: checkoutOrders.id }).from(checkoutOrders);
    const orderIds = rows.filter((row) => fixtureOrderIds.has(row.id)).map((row) => row.id);
    if (!orderIds.length) return;
    await db.update(checkoutOrders).set({ activeFulfillmentShipmentId: null }).where(
      inArray(checkoutOrders.id, orderIds),
    );
    const shipments = await db.select({ id: productShipments.id }).from(productShipments).where(
      inArray(productShipments.orderId, orderIds),
    );
    if (shipments.length) {
      await db.delete(productShipmentJobs).where(
        inArray(productShipmentJobs.shipmentId, shipments.map(({ id }) => id)),
      );
      await db.delete(productShipments).where(
        inArray(productShipments.id, shipments.map(({ id }) => id)),
      );
    }
    await db.delete(orderPaymentObligations).where(
      inArray(orderPaymentObligations.orderId, orderIds),
    );
    await db.delete(checkoutOrders).where(inArray(checkoutOrders.id, orderIds));
  }

  const fixtureOrderIds = new Set();
  try {
    const [order] = await db.insert(checkoutOrders).values({
      orderId: prefix + crypto.randomUUID(),
      purpose: "product",
      status: "paid",
      customerName: "Test Customer",
      customerEmail: "customer@example.invalid",
      amountCents: 1000,
      merchandiseAmountCents: 1000,
      lineItems: [],
      paymentRiskStatus: "cleared",
    }).returning();
    fixtureOrderIds.add(order.id);
    const expiresAt = new Date("2026-08-20T00:00:00.000Z");
    const [source, prepared] = await db.insert(productShipments).values([
      {
        orderId: order.id,
        sequence: 0,
        publicReference: prefix + "source-" + crypto.randomUUID(),
        quoteTokenHash: prefix + "source-token-" + crypto.randomUUID(),
        quoteFingerprint: prefix + "source-fingerprint",
        status: "label_ready",
        destination,
        packageSnapshot,
        customsLines: [],
        rates: [],
        quoteExpiresAt: expiresAt,
      },
      {
        orderId: order.id,
        sequence: 1,
        purpose: "replacement",
        publicReference: prefix + "prepared-" + crypto.randomUUID(),
        quoteTokenHash: prefix + "prepared-token-" + crypto.randomUUID(),
        quoteFingerprint: prefix + "prepared-fingerprint",
        status: "ready_for_staff",
        destination,
        packageSnapshot,
        customsLines: [],
        rates: [],
        quoteExpiresAt: expiresAt,
      },
    ]).returning();
    await db.update(checkoutOrders).set({
      activeFulfillmentShipmentId: source.id,
    }).where(eq(checkoutOrders.id, order.id));

    assert.equal(await adoptPreparedShipmentGeneration({
      orderId: order.id,
      expectedActiveShipmentId: source.id,
      expectedActiveStateVersion: source.stateVersion,
      preparedShipmentId: prepared.id,
      expectedPreparedStateVersion: prepared.stateVersion,
    }), false, "an unpaid prepared generation cannot become active");
    const [settledPrepared] = await db.update(productShipments).set({
      status: "label_ready",
      purchasedAt: new Date(),
      actualPurchaseTotalCents: 200,
      stateVersion: prepared.stateVersion + 1,
    }).where(eq(productShipments.id, prepared.id)).returning();
    assert.equal(await adoptPreparedShipmentGeneration({
      orderId: order.id,
      expectedActiveShipmentId: source.id,
      expectedActiveStateVersion: source.stateVersion,
      preparedShipmentId: settledPrepared.id,
      expectedPreparedStateVersion: settledPrepared.stateVersion,
    }), true);
    assert.equal(await adoptPreparedShipmentGeneration({
      orderId: order.id,
      expectedActiveShipmentId: source.id,
      expectedActiveStateVersion: source.stateVersion,
      preparedShipmentId: settledPrepared.id,
      expectedPreparedStateVersion: settledPrepared.stateVersion,
    }), false, "a stale source generation cannot be re-adopted");

    assert.equal(await enqueueRefundOperationForOrder({
      orderReference: order.orderId,
      shipmentId: source.id,
      expectedStateVersion: source.stateVersion,
      idempotencyKey: prefix + "old-generation-refund",
    }), null, "a superseded generation cannot be refunded");
    const [purchasedPrepared] = await db.update(productShipments).set({
      stateVersion: settledPrepared.stateVersion + 1,
    }).where(eq(productShipments.id, settledPrepared.id)).returning();
    const refund = await enqueueRefundOperationForOrder({
      orderReference: order.orderId,
      shipmentId: prepared.id,
      expectedStateVersion: purchasedPrepared.stateVersion,
      idempotencyKey: prefix + "active-generation-refund",
    });
    assert.ok(refund, "the active generation can be targeted with its exact version");

    const currentPrepared = await db.query.productShipments.findFirst({
      where: eq(productShipments.id, prepared.id),
    });
    const tracking = await enqueueShipmentOperation({
      shipmentId: prepared.id,
      type: "tracking",
      idempotencyKey: prefix + "lease-fencing",
      payload: { expectedShipmentStateVersion: currentPrepared.stateVersion },
    });
    const firstClaimAt = new Date(Date.now() + 60_000);
    const firstClaim = await claimShipmentOperationJobs({
      workerId: "worker-a",
      types: ["tracking"],
      now: firstClaimAt,
    });
    const claimedA = firstClaim.find(({ id }) => id === tracking.id);
    assert.ok(claimedA, "the queued operation is claimable");
    const secondClaim = await claimShipmentOperationJobs({
      workerId: "worker-b",
      types: ["tracking"],
      now: new Date(firstClaimAt.getTime() + 6 * 60_000),
    });
    const claimedB = secondClaim.find(({ id }) => id === tracking.id);
    assert.ok(claimedB, "a five-minute expired lease is reclaimable");
    assert.equal(await completeShipmentJob(tracking.id, {
      outcomeCode: "stale-worker",
      leaseOwner: "worker-a",
      expectedStateVersion: claimedA.stateVersion,
    }), false, "the stale worker is fenced by owner and job version");
    assert.equal(await completeShipmentJob(tracking.id, {
      outcomeCode: "fresh-worker",
      leaseOwner: "worker-b",
      expectedStateVersion: claimedB.stateVersion,
    }), true);

    const mutating = await enqueueShipmentOperation({
      shipmentId: prepared.id,
      type: "delete",
      idempotencyKey: prefix + "expired-mutation-reconciliation",
      payload: { expectedShipmentStateVersion: currentPrepared.stateVersion },
    });
    const firstMutationClaimAt = new Date(firstClaimAt.getTime() + 15 * 60_000);
    const firstMutationClaim = await claimShipmentOperationJobs({
      workerId: "worker-c",
      types: ["delete"],
      now: firstMutationClaimAt,
    });
    const claimedMutationC = firstMutationClaim.find(({ id }) => id === mutating.id);
    assert.ok(claimedMutationC);
    assert.equal(claimedMutationC.outcomeUnknown, false);
    const secondMutationClaim = await claimShipmentOperationJobs({
      workerId: "worker-d",
      types: ["delete"],
      now: new Date(firstMutationClaimAt.getTime() + 6 * 60_000),
    });
    const claimedMutationD = secondMutationClaim.find(({ id }) => id === mutating.id);
    assert.ok(claimedMutationD);
    assert.equal(
      claimedMutationD.outcomeUnknown,
      true,
      "an expired mutating lease must reconcile before another provider call",
    );
    assert.equal(await completeShipmentJob(mutating.id, {
      outcomeCode: "stale-mutating-worker",
      leaseOwner: "worker-c",
      expectedStateVersion: claimedMutationC.stateVersion,
    }), false);
    assert.equal(await completeShipmentJob(mutating.id, {
      outcomeCode: "mutation-reconciled",
      leaseOwner: "worker-d",
      expectedStateVersion: claimedMutationD.stateVersion,
    }), true);

    const attachedExpiry = new Date(Date.now() - 60_000);
    const [expiredOrder] = await db.insert(checkoutOrders).values({
      orderId: prefix + "expired-attached-" + crypto.randomUUID(),
      purpose: "product",
      status: "pending",
      customerName: "Expired Customer",
      customerEmail: "expired@example.invalid",
      amountCents: 1200,
      merchandiseAmountCents: 1000,
      shippingAmountCents: 200,
      lineItems: [],
      paymentRiskStatus: "pending",
    }).returning();
    fixtureOrderIds.add(expiredOrder.id);
    const [expiredShipment] = await db.insert(productShipments).values({
      orderId: expiredOrder.id,
      sequence: 0,
      publicReference: prefix + "expired-shipment-" + crypto.randomUUID(),
      quoteTokenHash: prefix + "expired-token-" + crypto.randomUUID(),
      quoteFingerprint: prefix + "expired-fingerprint-" + crypto.randomUUID(),
      providerShipmentId: prefix + "expired-provider-" + crypto.randomUUID(),
      providerStatus: "unpaid",
      status: "payment_pending",
      destination,
      packageSnapshot,
      customsLines: [],
      rates: [],
      quoteExpiresAt: attachedExpiry,
    }).returning();
    await db.update(checkoutOrders).set({
      activeFulfillmentShipmentId: expiredShipment.id,
    }).where(eq(checkoutOrders.id, expiredOrder.id));
    await db.insert(orderPaymentObligations).values({
      orderId: expiredOrder.id,
      purpose: "primary",
      status: "pending",
      merchandiseAmountCents: 1000,
      shippingAmountCents: 200,
      taxAmountCents: 0,
      totalAmountCents: 1200,
      currency: "CAD",
      sourceWorkflow: "automated_product_checkout",
      taxPolicyVersion: "tax-test-v1",
      policyVersion: "shipping-test-v1",
      expiresAt: attachedExpiry,
      idempotencyKey: prefix + "expired-obligation-" + crypto.randomUUID(),
    });
    await abandonExpiredQuotes(new Date());
    const expiredAfterCleanupFence = await db.query.productShipments.findFirst({
      where: eq(productShipments.id, expiredShipment.id),
    });
    assert.equal(expiredAfterCleanupFence.status, "abandoned");
    const attachedCleanup = await db.query.productShipmentJobs.findFirst({
      where: eq(
        productShipmentJobs.idempotencyKey,
        "attached-quote-cleanup/" + expiredShipment.id,
      ),
    });
    assert.equal(attachedCleanup?.type, "cleanup");
    assert.equal(
      attachedCleanup?.payload?.expectedShipmentStateVersion,
      expiredAfterCleanupFence.stateVersion,
    );
  } finally {
    await cleanup();
    await closePrivateDbPool();
  }
`;

test(
  "shipment operations fence stale workers and target the active generation",
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
        env: process.env,
        stdio: "inherit",
      },
    );
  },
);
