import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run DB-backed shipping funding tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, inArray } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    checkoutOrders,
    productOrderAddressChangeRequests,
    productShipmentJobs,
    productShipments,
    shippingFundingReviews,
  } from "./src/lib/private-db/schema.ts";
  import {
    claimShipmentOperationJobs,
    enqueuePurchaseOperationForOrder,
    enqueuePreparedAddressPurchaseInTransaction,
    finalizeShipmentFundingReservation,
    recheckShipmentPurchaseFunding,
  } from "./src/lib/shipping/shipment-store.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";

  const db = getPrivateDb();
  const prefix = "lh-funding-reservation-db-test-" + crypto.randomUUID();
  const orderIds = [];
  const shipmentIds = [];
  const fundingReviewIds = [];
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

  async function createReadyOrder(suffix) {
    const [order] = await db.insert(checkoutOrders).values({
      orderId: prefix + "-order-" + suffix,
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
    orderIds.push(order.id);
    const [shipment] = await db.insert(productShipments).values({
      orderId: order.id,
      publicReference: prefix + "-shipment-" + suffix,
      quoteTokenHash: prefix + "-token-" + suffix,
      quoteFingerprint: prefix + "-fingerprint-" + suffix,
      status: "ready_for_staff",
      destination,
      packageSnapshot,
      customsLines: [],
      rates: [],
      quotedShippingCents: 200,
      quoteExpiresAt: new Date(now.getTime() + 60 * 60_000),
    }).returning();
    shipmentIds.push(shipment.id);
    await db.update(checkoutOrders).set({
      activeFulfillmentShipmentId: shipment.id,
    }).where(eq(checkoutOrders.id, order.id));
    return { order, shipment };
  }

  try {
    const [forecast] = await db.insert(shippingFundingReviews).values({
      kind: "thirty_day_review",
      status: "recorded",
      observedAt: now,
      validUntil: new Date(now.getTime() + 24 * 60 * 60_000),
    }).returning();
    fundingReviewIds.push(forecast.id);
    const [attestation] = await db.insert(shippingFundingReviews).values({
      kind: "balance_check",
      status: "recorded",
      balanceCents: 500,
      calculatedTwoBusinessDaySpendCents: 200,
      calculatedFiveBusinessDaySpendCents: 400,
      forecastReviewId: forecast.id,
      externalEvidenceReference: prefix + "-evidence",
      observedAt: now,
      validUntil: new Date(now.getTime() + 24 * 60 * 60_000),
    }).returning();
    fundingReviewIds.push(attestation.id);

    const fixtures = await Promise.all([
      createReadyOrder("a"),
      createReadyOrder("b"),
    ]);
    const admissions = await Promise.all(fixtures.map(({ order, shipment }, index) =>
      enqueuePurchaseOperationForOrder({
        orderReference: order.orderId,
        shipmentId: shipment.id,
        expectedStateVersion: shipment.stateVersion,
        idempotencyKey: prefix + "-purchase-" + index,
        payload: { postageType: "tracked_service" },
        now,
      }),
    ));
    const admitted = admissions.filter(Boolean);
    assert.equal(
      admitted.length,
      1,
      "serialized reservations must not spend below the two-business-day forecast",
    );
    const operation = admitted[0];
    assert.equal(operation.fundingAttestationId, attestation.id);
    assert.equal(operation.reservedFundingCents, 200);
    assert.equal(operation.fundingReservationStatus, "reserved");

    const claimNow = new Date(now.getTime() + 1_000);
    const claimedJobs = await claimShipmentOperationJobs({
      workerId: "funding-worker",
      types: ["purchase"],
      now: claimNow,
    });
    const claimed = claimedJobs.find(({ id }) => id === operation.id);
    assert.ok(claimed);
    assert.equal(await recheckShipmentPurchaseFunding({
      operationId: claimed.id,
      leaseOwner: "funding-worker",
      expectedStateVersion: claimed.stateVersion,
      requiredAmountCents: 301,
      now: claimNow,
    }), false, "the execution-time provider amount must be checked against the reserve floor");
    assert.equal(await recheckShipmentPurchaseFunding({
      operationId: claimed.id,
      leaseOwner: "funding-worker",
      expectedStateVersion: claimed.stateVersion,
      requiredAmountCents: 250,
      now: claimNow,
    }), true);
    const reserved = await db.query.productShipmentJobs.findFirst({
      where: eq(productShipmentJobs.id, claimed.id),
    });
    assert.equal(reserved.reservedFundingCents, 250);
    assert.equal(await finalizeShipmentFundingReservation({
      operationId: claimed.id,
      leaseOwner: "funding-worker",
      expectedStateVersion: claimed.stateVersion,
      outcome: "released",
      now: claimNow,
    }), true);
    const released = await db.query.productShipmentJobs.findFirst({
      where: eq(productShipmentJobs.id, claimed.id),
    });
    assert.equal(released.fundingReservationStatus, "released");

    const addressFixture = await createReadyOrder("address");
    const [safeSource] = await db.update(productShipments).set({
      status: "abandoned",
      stateVersion: addressFixture.shipment.stateVersion + 1,
    }).where(eq(productShipments.id, addressFixture.shipment.id)).returning();
    const [preparedAddressShipment] = await db.insert(productShipments).values({
      orderId: addressFixture.order.id,
      sequence: 1,
      purpose: "reshipment",
      supersedesShipmentId: safeSource.id,
      publicReference: prefix + "-address-prepared",
      quoteTokenHash: prefix + "-address-prepared-token",
      quoteFingerprint: prefix + "-address-prepared-fingerprint",
      providerShipmentId: prefix + "-address-prepared-provider",
      providerStatus: "unpaid",
      selectedRateId: "address-rate",
      selectedPostageType: "tracked_service",
      status: "ready_for_staff",
      destination,
      packageSnapshot,
      customsLines: [],
      rates: [],
      quotedShippingCents: 200,
      quoteExpiresAt: new Date(now.getTime() + 60 * 60_000),
    }).returning();
    shipmentIds.push(preparedAddressShipment.id);
    const [addressRequest] = await db.insert(productOrderAddressChangeRequests).values({
      orderId: addressFixture.order.id,
      shipmentId: safeSource.id,
      status: "approved",
      originalAddress: destination,
      proposedAddress: { ...destination, line1: "200 Replacement Street" },
      tokenHash: prefix + "-address-token",
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      expectedSourceShipmentId: safeSource.id,
      expectedSourceShipmentStateVersion: safeSource.stateVersion,
      preparedShipmentId: preparedAddressShipment.id,
      preparedShipmentStateVersion: preparedAddressShipment.stateVersion,
    }).returning();
    const addressPurchase = await db.transaction((tx) =>
      enqueuePreparedAddressPurchaseInTransaction(tx, {
        orderId: addressFixture.order.id,
        requestId: addressRequest.id,
        sourceShipmentId: safeSource.id,
        preparedShipmentId: preparedAddressShipment.id,
        expectedPreparedStateVersion: preparedAddressShipment.stateVersion,
        oldPostageOutcome: "delete_confirmed",
        payload: {
          measuredWeightGrams: packageSnapshot.totalWeightGrams,
          shipDate: now.toISOString().slice(0, 10),
        },
        now,
      }),
    );
    assert.ok(addressPurchase, "a safely reconciled address generation can reserve purchase");
    const [addressOrderAfterQueue, addressPreparedAfterQueue, addressRequestAfterQueue] =
      await Promise.all([
        db.query.checkoutOrders.findFirst({ where: eq(checkoutOrders.id, addressFixture.order.id) }),
        db.query.productShipments.findFirst({ where: eq(productShipments.id, preparedAddressShipment.id) }),
        db.query.productOrderAddressChangeRequests.findFirst({
          where: eq(productOrderAddressChangeRequests.id, addressRequest.id),
        }),
      ]);
    assert.equal(
      addressOrderAfterQueue.activeFulfillmentShipmentId,
      safeSource.id,
      "the replacement must not become active before settled purchase",
    );
    assert.equal(addressPreparedAfterQueue.status, "purchase_pending");
    assert.equal(addressRequestAfterQueue.oldPostageOutcome, "delete_confirmed");
    assert.equal(addressRequestAfterQueue.reconciliationState, "replacement_purchase_queued");
    const addressClaimNow = new Date(now.getTime() + 2_000);
    const addressClaims = await claimShipmentOperationJobs({
      workerId: "address-funding-worker",
      types: ["purchase"],
      now: addressClaimNow,
    });
    const addressClaim = addressClaims.find(({ id }) => id === addressPurchase.id);
    assert.ok(addressClaim);
    assert.equal(await recheckShipmentPurchaseFunding({
      operationId: addressClaim.id,
      leaseOwner: "address-funding-worker",
      expectedStateVersion: addressClaim.stateVersion,
      requiredAmountCents: 200,
      now: addressClaimNow,
    }), true, "the exact non-active prepared address generation remains authorized");
  } finally {
    if (orderIds.length) {
      await db.update(checkoutOrders).set({ activeFulfillmentShipmentId: null }).where(
        inArray(checkoutOrders.id, orderIds),
      );
    }
    if (shipmentIds.length) {
      await db.delete(productOrderAddressChangeRequests).where(
        inArray(productOrderAddressChangeRequests.orderId, orderIds),
      );
      await db.delete(productShipmentJobs).where(
        inArray(productShipmentJobs.shipmentId, shipmentIds),
      );
      await db.delete(productShipments).where(
        inArray(productShipments.id, shipmentIds),
      );
    }
    if (orderIds.length) {
      await db.delete(checkoutOrders).where(inArray(checkoutOrders.id, orderIds));
    }
    for (const fundingReviewId of fundingReviewIds.reverse()) {
      await db.delete(shippingFundingReviews).where(eq(shippingFundingReviews.id, fundingReviewId));
    }
    await closePrivateDbPool();
  }
`;

test(
  "funding reservations serialize purchase exposure and recheck the provider amount",
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
