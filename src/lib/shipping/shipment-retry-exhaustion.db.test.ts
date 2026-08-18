import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run DB-backed shipment retry tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, inArray } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    productShipmentJobs,
    productShipments,
  } from "./src/lib/private-db/schema.ts";
  import {
    MAX_SHIPMENT_OPERATION_ATTEMPTS,
    recordUnsettledProviderAccountingEvidence,
    retryShipmentJob,
  } from "./src/lib/shipping/shipment-store.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";

  const db = getPrivateDb();
  const prefix = "lh-shipment-retry-exhaustion-" + crypto.randomUUID();
  const now = new Date();
  const shipmentIds = [];
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

  async function fixture(suffix, outcomeUnknown) {
    const [shipment] = await db.insert(productShipments).values({
      publicReference: prefix + "-shipment-" + suffix,
      quoteTokenHash: prefix + "-token-" + suffix,
      quoteFingerprint: prefix + "-fingerprint-" + suffix,
      status: "purchase_pending",
      destination,
      packageSnapshot,
      customsLines: [],
      rates: [],
      quotedShippingCents: 200,
      quoteExpiresAt: new Date(now.getTime() + 60_000),
    }).returning();
    shipmentIds.push(shipment.id);
    const [job] = await db.insert(productShipmentJobs).values({
      shipmentId: shipment.id,
      type: "purchase",
      status: "processing",
      idempotencyKey: prefix + "-job-" + suffix,
      attemptCount: MAX_SHIPMENT_OPERATION_ATTEMPTS,
      leaseOwner: prefix + "-worker-" + suffix,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      outcomeUnknown,
    }).returning();
    return { shipment, job };
  }

  try {
    const known = await fixture("known", false);
    const knownResult = await retryShipmentJob(known.job.id, {
      error: "known provider rejection",
      leaseOwner: known.job.leaseOwner,
      expectedStateVersion: known.job.stateVersion,
      attemptCount: MAX_SHIPMENT_OPERATION_ATTEMPTS,
      outcomeUnknown: false,
      now,
      jitter: 0,
    });
    assert.deepEqual(knownResult, {
      status: "dead_lettered",
      outcomeUnknown: false,
      fundingReservation: "not_applicable",
    });

    const ambiguous = await fixture("ambiguous", true);
    const ambiguousResult = await retryShipmentJob(ambiguous.job.id, {
      error: "ambiguous provider mutation",
      leaseOwner: ambiguous.job.leaseOwner,
      expectedStateVersion: ambiguous.job.stateVersion,
      attemptCount: MAX_SHIPMENT_OPERATION_ATTEMPTS,
      outcomeUnknown: true,
      now,
      jitter: 0,
    });
    assert.deepEqual(ambiguousResult, {
      status: "dead_lettered",
      outcomeUnknown: true,
      fundingReservation: "not_applicable",
    });

    const [knownJob, ambiguousJob, knownShipment, ambiguousShipment] =
      await Promise.all([
        db.query.productShipmentJobs.findFirst({ where: eq(productShipmentJobs.id, known.job.id) }),
        db.query.productShipmentJobs.findFirst({ where: eq(productShipmentJobs.id, ambiguous.job.id) }),
        db.query.productShipments.findFirst({ where: eq(productShipments.id, known.shipment.id) }),
        db.query.productShipments.findFirst({ where: eq(productShipments.id, ambiguous.shipment.id) }),
      ]);
    assert.equal(knownJob.status, "dead_letter");
    assert.equal(ambiguousJob.status, "dead_letter");
    assert.equal(knownShipment.status, "manual_review");
    assert.equal(ambiguousShipment.status, "manual_review");

    const evidence = await fixture("component-evidence", true);
    assert.equal(await recordUnsettledProviderAccountingEvidence({
      id: evidence.shipment.id,
      expectedStateVersion: evidence.shipment.stateVersion,
      providerStatus: "ready",
      rawShipment: { id: prefix + "-provider-evidence", status: "ready" },
      actualPostageCents: 800,
      actualInsuranceCents: 100,
      actualDeliveryFeeCents: 50,
      actualTariffFeeCents: 25,
      actualFdaPriorNotificationFeeCents: 0,
      actualFederalTaxCents: 100,
      actualProvincialTaxCents: 159,
      now,
    }), true);
    const componentEvidence = await db.query.productShipments.findFirst({
      where: eq(productShipments.id, evidence.shipment.id),
    });
    assert.equal(componentEvidence.status, "manual_review");
    assert.equal(componentEvidence.actualPurchaseTotalCents, null);
    assert.equal(componentEvidence.actualPostageCents, 800);
    assert.equal(componentEvidence.actualProvincialTaxCents, 159);
  } finally {
    if (shipmentIds.length) {
      await db.delete(productShipmentJobs).where(inArray(productShipmentJobs.shipmentId, shipmentIds));
      await db.delete(productShipments).where(inArray(productShipments.id, shipmentIds));
    }
    await closePrivateDbPool();
  }
`;

test(
  "retry exhaustion atomically dead-letters and routes shipments to manual review",
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
