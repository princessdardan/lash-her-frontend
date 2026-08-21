import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run shipment-store provider-update DB tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, inArray } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    checkoutOrders,
    customerEmailOutbox,
    productShipmentJobs,
    productShipments,
  } from "./src/lib/private-db/schema.ts";
  import {
    enqueueShipmentJob,
    enqueueUnpaidProviderDraftCleanup,
    recordUnsettledProviderAccountingEvidence,
    updateShipmentFromProvider,
  } from "./src/lib/shipping/shipment-store.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";
  process.env.CHECKOUT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.CHITCHATS_ACCESS_TOKEN = "shipment-store-db-test-token";
  process.env.CHITCHATS_CLIENT_ID = "shipment-store-db-test-client";
  process.env.CHITCHATS_ENVIRONMENT = "staging";
  process.env.CHITCHATS_REGION = "ontario_manitoba";
  process.env.CHITCHATS_QUOTE_SIGNING_SECRET = "shipment-store-db-test-signing-secret-32-bytes";

  const db = getPrivateDb();
  const prefix = "lh-shipment-store-db-" + crypto.randomUUID();
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

  const t0 = new Date("2026-08-19T09:00:00.000Z");
  const t1 = new Date("2026-08-19T10:00:00.000Z");
  const t2 = new Date("2026-08-19T11:00:00.000Z");
  const past = new Date("2026-08-19T08:00:00.000Z");

  const createdShipmentIds = [];
  let orderId = null;
  let nextSequence = 0;

  async function seedShipment(suffix, options) {
    const opts = options ?? {};
    const [row] = await db.insert(productShipments).values({
      orderId: opts.orderId === undefined ? orderId : opts.orderId,
      sequence: nextSequence++,
      publicReference: prefix + suffix + "-ref-" + crypto.randomUUID(),
      quoteTokenHash: prefix + suffix + "-token-" + crypto.randomUUID(),
      quoteFingerprint: prefix + suffix + "-fp",
      status: opts.status,
      destination,
      packageSnapshot,
      customsLines: [],
      rates: [],
      quoteExpiresAt: new Date("2026-09-01T00:00:00.000Z"),
      ...(opts.extra ?? {}),
    }).returning();
    createdShipmentIds.push(row.id);
    return row;
  }

  async function findShipment(id) {
    return db.query.productShipments.findFirst({ where: eq(productShipments.id, id) });
  }

  async function outboxByKey(key) {
    return db.select().from(customerEmailOutbox).where(
      eq(customerEmailOutbox.providerIdempotencyKey, key),
    );
  }

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
      lineItems: [],
      paymentRiskStatus: "cleared",
      piiRedactionDueAt: new Date("2026-09-01T12:00:00.000Z"),
    }).returning();
    orderId = order.id;

    // --- Scenario A: rich in_transit update with a valid https tracking URL,
    // valid tracking number, valid estimated-delivery date, full actual-cost
    // fields, and an accepted-kind customer notification enqueue.
    const shA = await seedShipment("-a", {
      status: "purchase_pending",
      extra: { quotedShippingCents: 200 },
    });
    assert.equal(await updateShipmentFromProvider({
      id: shA.id,
      expectedStateVersion: shA.stateVersion,
      status: "in_transit",
      providerStatus: "released",
      rawShipment: { note: "in-transit" },
      trackingNumber: "TRACK-123",
      trackingUrl: "https://track.example/abc",
      actualPostageCents: 100,
      actualInsuranceCents: 20,
      actualPurchaseTotalCents: 500,
      actualDeliveryFeeCents: 5,
      actualTariffFeeCents: 6,
      actualFdaPriorNotificationFeeCents: 7,
      actualFederalTaxCents: 8,
      actualProvincialTaxCents: 9,
      estimatedDeliveryAt: "2026-09-01T00:00:00.000Z",
      providerEventAt: t1,
      providerPurchasedAt: past,
      providerShipDateAt: past,
    }), true);
    const afterA = await findShipment(shA.id);
    assert.equal(afterA.status, "in_transit");
    assert.equal(afterA.trackingNumber, "TRACK-123");
    assert.equal(afterA.trackingUrl, "https://track.example/abc");
    assert.equal(afterA.providerCostCurrency, "CAD");
    assert.equal(afterA.actualPurchaseTotalCents, 500);
    assert.equal(afterA.purchaseVarianceCents, 300);
    assert.ok(afterA.acceptedAt);
    assert.ok(afterA.purchasedAt);
    assert.equal(
      afterA.latestEstimatedDeliveryAt.toISOString(),
      "2026-09-01T00:00:00.000Z",
    );
    assert.equal(afterA.providerEventAt.toISOString(), t1.toISOString());
    const acceptedEmail = await outboxByKey("product-shipment-accepted:" + shA.id);
    assert.equal(acceptedEmail.length, 1, "accepted notification is enqueued once");

    // --- Scenario B: a stale provider event (older than the recorded event)
    // must not regress the shipment.
    assert.equal(await updateShipmentFromProvider({
      id: shA.id,
      status: "in_transit",
      providerStatus: "released",
      rawShipment: {},
      providerEventAt: t0,
    }), false, "an out-of-order provider event is fenced");

    // --- Scenario C: delivered update with a garbage tracking URL (rejected to
    // null), a null tracking number, an unparseable estimated-delivery date, and
    // no cost fields; enqueues a delivered-kind notification.
    assert.equal(await updateShipmentFromProvider({
      id: shA.id,
      status: "delivered",
      providerStatus: "delivered",
      rawShipment: { note: "delivered" },
      trackingNumber: null,
      trackingUrl: "garbage-not-a-url",
      estimatedDeliveryAt: "not-a-real-date",
      providerEventAt: t2,
    }), true);
    const afterC = await findShipment(shA.id);
    assert.equal(afterC.status, "delivered");
    assert.equal(afterC.trackingNumber, null);
    assert.equal(afterC.trackingUrl, null, "a non-parseable tracking URL is dropped");
    assert.ok(afterC.deliveredAt);
    assert.ok(afterC.privacyTerminalAt);
    assert.equal(afterC.latestEstimatedDeliveryAt, null);
    assert.equal(afterC.actualPurchaseTotalCents, 500, "omitted cost fields are untouched");
    const deliveredEmail = await outboxByKey("product-shipment-delivered:" + shA.id);
    assert.equal(deliveredEmail.length, 1, "delivered notification is enqueued once");

    // --- Scenario D: exception update where the exception email was already
    // sent (alreadySent guard suppresses the duplicate); whitespace tracking
    // number and null tracking URL both sanitize to null.
    const shB = await seedShipment("-b", {
      status: "in_transit",
      extra: {
        providerEventAt: past,
        exceptionEmailSentAt: new Date("2026-08-19T07:00:00.000Z"),
      },
    });
    assert.equal(await updateShipmentFromProvider({
      id: shB.id,
      status: "exception",
      providerStatus: "exception",
      rawShipment: {},
      trackingNumber: "   ",
      trackingUrl: null,
      providerEventAt: t1,
    }), true);
    const afterD = await findShipment(shB.id);
    assert.equal(afterD.status, "exception");
    assert.equal(afterD.trackingNumber, null, "whitespace tracking number sanitizes to null");
    assert.equal(afterD.trackingUrl, null);
    const exceptionEmail = await outboxByKey("product-shipment-exception:" + shB.id);
    assert.equal(exceptionEmail.length, 0, "an already-sent exception is not re-enqueued");

    // --- Scenario E: voided update (no customer notification kind) with an
    // http (non-https) tracking URL that is rejected to null; voided sets the
    // privacy-terminal marker.
    const shC = await seedShipment("-c", {
      status: "accepted",
      extra: { providerEventAt: past },
    });
    assert.equal(await updateShipmentFromProvider({
      id: shC.id,
      status: "voided",
      providerStatus: "voided",
      rawShipment: {},
      trackingUrl: "http://plain.example/track",
      providerEventAt: t1,
    }), true);
    const afterE = await findShipment(shC.id);
    assert.equal(afterE.status, "voided");
    assert.equal(afterE.trackingUrl, null, "a non-https tracking URL is rejected");
    assert.ok(afterE.privacyTerminalAt);

    // --- Scenario F: manual_review update with no providerEventAt (defaults to
    // now), a null estimated-delivery date, and omitted tracking fields.
    const shD = await seedShipment("-d", {
      status: "accepted",
      extra: { providerEventAt: past },
    });
    assert.equal(await updateShipmentFromProvider({
      id: shD.id,
      status: "manual_review",
      providerStatus: "resolved",
      rawShipment: {},
      estimatedDeliveryAt: null,
    }), true);
    const afterF = await findShipment(shD.id);
    assert.equal(afterF.status, "manual_review");
    assert.ok(afterF.manualReviewStartedAt);
    assert.equal(afterF.latestEstimatedDeliveryAt, null);
    assert.ok(afterF.providerEventAt, "a defaulted provider event timestamp is recorded");

    // --- Scenario G: an unattached shipment (no order) still updates, but the
    // notification join yields no context so nothing is enqueued.
    const shE = await seedShipment("-e", {
      orderId: null,
      status: "purchase_pending",
    });
    assert.equal(await updateShipmentFromProvider({
      id: shE.id,
      status: "in_transit",
      providerStatus: "released",
      rawShipment: {},
      providerEventAt: t1,
    }), true);
    const afterG = await findShipment(shE.id);
    assert.equal(afterG.status, "in_transit");

    // --- recordUnsettledProviderAccountingEvidence: settle with matching state
    // version (success + cost fields), then a stale version (failure).
    const shF = await seedShipment("-f", { status: "label_ready" });
    assert.equal(await recordUnsettledProviderAccountingEvidence({
      id: shF.id,
      expectedStateVersion: shF.stateVersion,
      providerStatus: "unsettled",
      rawShipment: { evidence: 1 },
      actualPostageCents: 111,
      actualInsuranceCents: 22,
      actualDeliveryFeeCents: 3,
      actualTariffFeeCents: 4,
      actualFdaPriorNotificationFeeCents: 5,
      actualFederalTaxCents: 6,
      actualProvincialTaxCents: 7,
    }), true);
    const afterUnsettled = await findShipment(shF.id);
    assert.equal(afterUnsettled.status, "manual_review");
    assert.equal(afterUnsettled.actualPostageCents, 111);
    assert.ok(afterUnsettled.manualReviewStartedAt);
    assert.equal(await recordUnsettledProviderAccountingEvidence({
      id: shF.id,
      expectedStateVersion: shF.stateVersion,
      providerStatus: "unsettled-retry",
      rawShipment: {},
    }), false, "a stale state version cannot re-record evidence");

    // --- enqueueShipmentJob: create, idempotent re-enqueue, conflicting reuse,
    // and an explicit-hash / no-payload variant.
    const job1 = await enqueueShipmentJob({
      shipmentId: shF.id,
      type: "tracking",
      idempotencyKey: prefix + "-job1",
      payload: { attempt: 1 },
    });
    assert.ok(job1.id);
    const job1Again = await enqueueShipmentJob({
      shipmentId: shF.id,
      type: "tracking",
      idempotencyKey: prefix + "-job1",
      payload: { attempt: 1 },
    });
    assert.equal(job1Again.id, job1.id, "an identical re-enqueue returns the existing job");
    await assert.rejects(
      () => enqueueShipmentJob({
        shipmentId: shF.id,
        type: "tracking",
        idempotencyKey: prefix + "-job1",
        payload: { attempt: 2 },
      }),
      /idempotency key was reused/,
    );
    const job2 = await enqueueShipmentJob({
      shipmentId: shF.id,
      type: "tracking",
      idempotencyKey: prefix + "-job2",
      operationPayloadHash: "deadbeef",
    });
    assert.equal(job2.operationPayloadHash, "deadbeef");

    // --- enqueueUnpaidProviderDraftCleanup: create an abandoned reshipment draft
    // plus its cleanup job, then confirm the idempotent conflict path returns the
    // same operation.
    const sourceRow = await findShipment(shF.id);
    const cleanupProvider = prefix + "-cleanup-provider-" + crypto.randomUUID();
    const op1 = await enqueueUnpaidProviderDraftCleanup({
      source: sourceRow,
      providerShipmentId: cleanupProvider,
      providerStatus: "unpaid",
      publicReference: prefix + "-cleanup-ref-" + crypto.randomUUID(),
      destination,
      rawShipment: { cleanup: 1 },
      reason: "unpaid_provider_draft",
    });
    assert.ok(op1, "a cleanup operation is enqueued for a fresh provider draft");
    createdShipmentIds.push(op1.shipmentId);
    const op2 = await enqueueUnpaidProviderDraftCleanup({
      source: sourceRow,
      providerShipmentId: cleanupProvider,
      providerStatus: "unpaid",
      publicReference: prefix + "-cleanup-ref2-" + crypto.randomUUID(),
      destination,
      rawShipment: { cleanup: 2 },
      reason: "unpaid_provider_draft",
    });
    assert.ok(op2, "the idempotent cleanup returns the existing operation");
    assert.equal(op2.id, op1.id, "the same provider draft yields the same cleanup operation");
  } finally {
    if (createdShipmentIds.length) {
      await db.delete(productShipmentJobs).where(
        inArray(productShipmentJobs.shipmentId, createdShipmentIds),
      );
    }
    if (orderId) {
      await db.delete(customerEmailOutbox).where(eq(customerEmailOutbox.orderId, orderId));
    }
    if (createdShipmentIds.length) {
      await db.delete(productShipments).where(
        inArray(productShipments.id, createdShipmentIds),
      );
    }
    if (orderId) {
      await db.delete(checkoutOrders).where(eq(checkoutOrders.id, orderId));
    }
    await closePrivateDbPool();
  }
`;

test(
  "shipment-store applies provider updates, unsettled evidence, and cleanup enqueues",
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
