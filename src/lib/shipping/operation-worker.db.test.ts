import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run DB-backed shipping operation worker tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, inArray } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    productShipmentJobs,
    productShipments,
  } from "./src/lib/private-db/schema.ts";
  import {
    claimShipmentOperationJobs,
  } from "./src/lib/shipping/shipment-store.ts";
  import {
    processClaimedShipmentOperation,
  } from "./src/lib/shipping/operation-worker.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";
  process.env.CHITCHATS_ACCESS_TOKEN = "operation-worker-test-token";
  process.env.CHITCHATS_CHECKOUT_ENABLED = "true";
  process.env.CHITCHATS_CLIENT_ID = "operation-worker-test-client";
  process.env.CHITCHATS_ENVIRONMENT = "staging";
  process.env.CHITCHATS_QUOTE_SIGNING_SECRET = "operation-worker-test-signing-secret-32-bytes";
  process.env.CHITCHATS_REGION = "ontario_manitoba";
  process.env.CHITCHATS_SHIPPING_ENABLED = "true";

  const db = getPrivateDb();
  const prefix = "lh-provider-draft-fence-" + crypto.randomUUID();
  const shipmentIds = [];
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

  async function createFixture(suffix, outcomeUnknown) {
    const publicReference = prefix + "-" + suffix;
    const [shipment] = await db.insert(productShipments).values({
      publicReference,
      quoteTokenHash: publicReference + "-token",
      quoteFingerprint: publicReference + "-fingerprint",
      status: "quote_pending",
      destination,
      packageSnapshot,
      customsLines: [],
      rates: [],
      quoteExpiresAt: new Date(now.getTime() + 60 * 60_000),
    }).returning();
    shipmentIds.push(shipment.id);
    const [job] = await db.insert(productShipmentJobs).values({
      shipmentId: shipment.id,
      type: "create",
      status: outcomeUnknown ? "retryable_failed" : "queued",
      idempotencyKey: publicReference + "-create",
      availableAt: new Date(now.getTime() - 1_000),
      nextAttemptAt: outcomeUnknown ? new Date(now.getTime() - 1_000) : null,
      outcomeUnknown,
      payload: {
        expectedShipmentStateVersion: shipment.stateVersion,
        merchandiseValueCents: 1_000,
        signatureRequested: false,
      },
    }).returning();
    const claimed = await claimShipmentOperationJobs({
      workerId: "worker-" + suffix,
      types: ["create"],
      now,
    });
    return {
      shipment,
      job: claimed.find((candidate) => candidate.id === job.id),
    };
  }

  function clientFor(provider, counters) {
    return {
      async createShipment() {
        counters.creates += 1;
        return provider;
      },
      async getShipment() {
        counters.gets += 1;
        return counters.getResult ?? provider;
      },
      async findShipments() {
        counters.finds += 1;
        return counters.findResult ?? [provider];
      },
      async refreshShipment() { return provider; },
      async buyShipment() {
        counters.buys = (counters.buys ?? 0) + 1;
        return provider;
      },
      async deleteShipment() { counters.deletes += 1; },
      async refundShipment() { return provider; },
      async listReturns() { return []; },
    };
  }

  async function assertFencedDraft(shipmentId, providerId) {
    const shipment = await db.query.productShipments.findFirst({
      where: eq(productShipments.id, shipmentId),
    });
    assert.equal(shipment.providerShipmentId, providerId);
    assert.equal(shipment.providerStatus, "unpaid");
    assert.equal(shipment.status, "abandoned");
    assert.equal(shipment.manualReviewStartedAt, null);
    assert.equal("postage_label_pdf_url" in shipment.rawShipment, false);
    const jobs = await db.select().from(productShipmentJobs).where(
      eq(productShipmentJobs.shipmentId, shipmentId),
    );
    const cleanupJobs = jobs.filter((job) => job.type === "cleanup");
    assert.equal(cleanupJobs.length, 1);
    const [cleanup] = cleanupJobs;
    assert.equal(cleanup.type, "cleanup");
    assert.equal(cleanup.status, "queued");
    assert.equal(
      cleanup.payload.expectedShipmentStateVersion,
      shipment.stateVersion,
    );
    return cleanup;
  }

  async function reclaimCreate(jobId, suffix) {
    const current = await db.query.productShipmentJobs.findFirst({
      where: eq(productShipmentJobs.id, jobId),
    });
    assert.ok(current);
    await db.update(productShipmentJobs).set({
      status: "retryable_failed",
      outcomeUnknown: true,
      nextAttemptAt: new Date(now.getTime() - 1_000),
      completedAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      stateVersion: current.stateVersion + 1,
    }).where(eq(productShipmentJobs.id, jobId));
    const claimed = await claimShipmentOperationJobs({
      workerId: "worker-reclaimed-" + suffix,
      types: ["create"],
      now,
    });
    return claimed.find((candidate) => candidate.id === jobId);
  }

  try {
    const direct = await createFixture("direct", false);
    assert.ok(direct.job);
    const directProvider = {
      id: prefix + "-provider-direct",
      order_id: direct.shipment.publicReference,
      status: "unpaid",
      postage_label_pdf_url: "https://example.invalid/signed-label?auth_token=secret",
    };
    const directCounters = { creates: 0, finds: 0, gets: 0, deletes: 0 };
    let directContextChecks = 0;
    const directResult = await processClaimedShipmentOperation(direct.job, {
      client: clientFor(directProvider, directCounters),
      workerId: "worker-direct",
      now: () => now,
      assertQuoteContextCurrent: async () => {
        directContextChecks += 1;
        if (directContextChecks === 2) throw new Error("context changed");
      },
    });
    assert.equal(directResult, "succeeded");
    assert.equal(directCounters.creates, 1);
    assert.equal(directCounters.finds, 0);
    assert.equal(directContextChecks, 2);
    const directCleanup = await assertFencedDraft(
      direct.shipment.id,
      directProvider.id,
    );

    const claimedCleanupJobs = await claimShipmentOperationJobs({
      workerId: "worker-cleanup",
      types: ["cleanup"],
      now,
    });
    const claimedCleanup = claimedCleanupJobs.find(
      (candidate) => candidate.id === directCleanup.id,
    );
    assert.ok(claimedCleanup);
    directCounters.getResult = {
      ...directProvider,
      status: "postage_purchased",
    };
    const cleanupResult = await processClaimedShipmentOperation(claimedCleanup, {
      client: clientFor(directProvider, directCounters),
      workerId: "worker-cleanup",
      now: () => now,
    });
    assert.equal(cleanupResult, "deadLettered");
    assert.equal(directCounters.gets, 1);
    assert.equal(directCounters.deletes, 0);

    const reclaimedAfterDeadLetter = await reclaimCreate(
      direct.job.id,
      "dead-letter",
    );
    assert.ok(reclaimedAfterDeadLetter);
    const reclaimedDeadLetterResult = await processClaimedShipmentOperation(
      reclaimedAfterDeadLetter,
      {
        client: clientFor(directProvider, directCounters),
        workerId: "worker-reclaimed-dead-letter",
        now: () => now,
        assertQuoteContextCurrent: async () => {
          throw new Error("context changed");
        },
      },
    );
    assert.equal(reclaimedDeadLetterResult, "succeeded");
    assert.equal(directCounters.finds, 0);
    const directAfterReclaim = await db.query.productShipments.findFirst({
      where: eq(productShipments.id, direct.shipment.id),
    });
    assert.equal(directAfterReclaim.status, "manual_review");
    const directCleanupAfterReclaim = await db.query.productShipmentJobs.findFirst({
      where: eq(productShipmentJobs.id, directCleanup.id),
    });
    assert.equal(directCleanupAfterReclaim.status, "dead_letter");
    const directCreateAfterReclaim = await db.query.productShipmentJobs.findFirst({
      where: eq(productShipmentJobs.id, direct.job.id),
    });
    assert.equal(
      directCreateAfterReclaim.outcomeCode,
      "shipping_quote_context_changed_cleanup_manual_review",
    );

    const cleaned = await createFixture("cleaned", false);
    assert.ok(cleaned.job);
    const cleanedProvider = {
      id: prefix + "-provider-cleaned",
      order_id: cleaned.shipment.publicReference,
      status: "unpaid",
    };
    const cleanedCounters = { creates: 0, finds: 0, gets: 0, deletes: 0 };
    let cleanedContextChecks = 0;
    const cleanedCreateResult = await processClaimedShipmentOperation(cleaned.job, {
      client: clientFor(cleanedProvider, cleanedCounters),
      workerId: "worker-cleaned-create",
      now: () => now,
      assertQuoteContextCurrent: async () => {
        cleanedContextChecks += 1;
        if (cleanedContextChecks === 2) throw new Error("context changed");
      },
    });
    assert.equal(cleanedCreateResult, "succeeded");
    const cleanedCleanup = await assertFencedDraft(
      cleaned.shipment.id,
      cleanedProvider.id,
    );
    const claimedCleanedCleanupJobs = await claimShipmentOperationJobs({
      workerId: "worker-cleaned-cleanup",
      types: ["cleanup"],
      now,
    });
    const claimedCleanedCleanup = claimedCleanedCleanupJobs.find(
      (candidate) => candidate.id === cleanedCleanup.id,
    );
    assert.ok(claimedCleanedCleanup);
    const cleanedCleanupResult = await processClaimedShipmentOperation(
      claimedCleanedCleanup,
      {
        client: clientFor(cleanedProvider, cleanedCounters),
        workerId: "worker-cleaned-cleanup",
        now: () => now,
      },
    );
    assert.equal(cleanedCleanupResult, "succeeded");
    assert.equal(cleanedCounters.deletes, 1);
    cleanedCounters.findResult = [];

    const reclaimedAfterSucceeded = await reclaimCreate(
      cleaned.job.id,
      "succeeded",
    );
    assert.ok(reclaimedAfterSucceeded);
    const reclaimedSucceededResult = await processClaimedShipmentOperation(
      reclaimedAfterSucceeded,
      {
        client: clientFor(cleanedProvider, cleanedCounters),
        workerId: "worker-reclaimed-succeeded",
        now: () => now,
        assertQuoteContextCurrent: async () => {
          throw new Error("context changed");
        },
      },
    );
    assert.equal(reclaimedSucceededResult, "succeeded");
    assert.equal(cleanedCounters.deletes, 1);
    assert.equal(cleanedCounters.finds, 0);
    const cleanedAfterReclaim = await db.query.productShipments.findFirst({
      where: eq(productShipments.id, cleaned.shipment.id),
    });
    assert.equal(cleanedAfterReclaim.status, "abandoned");
    const cleanedCleanupAfterReclaim = await db.query.productShipmentJobs.findFirst({
      where: eq(productShipmentJobs.id, cleanedCleanup.id),
    });
    assert.equal(cleanedCleanupAfterReclaim.status, "succeeded");
    const cleanedCreateAfterReclaim = await db.query.productShipmentJobs.findFirst({
      where: eq(productShipmentJobs.id, cleaned.job.id),
    });
    assert.equal(
      cleanedCreateAfterReclaim.outcomeCode,
      "shipping_quote_context_changed_provider_already_cleaned",
    );
    const cleanedJobs = await db.select().from(productShipmentJobs).where(
      eq(productShipmentJobs.shipmentId, cleaned.shipment.id),
    );
    assert.equal(cleanedJobs.filter((job) => job.type === "cleanup").length, 1);

    const reconciled = await createFixture("reconciled", true);
    assert.ok(reconciled.job);
    const reconciledProvider = {
      id: prefix + "-provider-reconciled",
      order_id: reconciled.shipment.publicReference,
      status: "unpaid",
      postage_label_pdf_url: "https://example.invalid/another-secret-label",
    };
    const reconciledCounters = { creates: 0, finds: 0, gets: 0, deletes: 0 };
    let reconciliationContextChecks = 0;
    const reconciliationResult = await processClaimedShipmentOperation(
      reconciled.job,
      {
        client: clientFor(reconciledProvider, reconciledCounters),
        workerId: "worker-reconciled",
        now: () => now,
        assertQuoteContextCurrent: async () => {
          reconciliationContextChecks += 1;
          throw new Error("context changed");
        },
      },
    );
    assert.equal(reconciliationResult, "succeeded");
    assert.equal(reconciledCounters.creates, 0);
    assert.equal(reconciledCounters.finds, 1);
    assert.equal(reconciliationContextChecks, 1);
    await assertFencedDraft(
      reconciled.shipment.id,
      reconciledProvider.id,
    );

    const ambiguousPurchaseReference = prefix + "-ambiguous-purchase";
    const [ambiguousPurchaseShipment] = await db.insert(productShipments).values({
      publicReference: ambiguousPurchaseReference,
      quoteTokenHash: ambiguousPurchaseReference + "-token",
      quoteFingerprint: ambiguousPurchaseReference + "-fingerprint",
      providerShipmentId: ambiguousPurchaseReference + "-provider",
      providerStatus: "postage_requested",
      selectedRateId: "rate-1",
      selectedPostageType: "tracked_service",
      quotedShippingCents: 500,
      status: "purchase_pending",
      destination,
      packageSnapshot,
      customsLines: [],
      rates: [],
      quoteExpiresAt: new Date(now.getTime() + 60 * 60_000),
    }).returning();
    shipmentIds.push(ambiguousPurchaseShipment.id);
    const purchasePayload = {
      expectedShipmentStateVersion: ambiguousPurchaseShipment.stateVersion,
      atRiskValueCents: 1_000,
      measuredWeightGrams: packageSnapshot.totalWeightGrams,
      shipDate: now.toISOString().slice(0, 10),
    };
    const [ambiguousPurchaseJob] = await db.insert(productShipmentJobs).values({
      shipmentId: ambiguousPurchaseShipment.id,
      type: "purchase",
      status: "retryable_failed",
      outcomeUnknown: true,
      idempotencyKey: ambiguousPurchaseReference + "-job",
      availableAt: new Date(now.getTime() - 1_000),
      nextAttemptAt: new Date(now.getTime() - 1_000),
      payload: purchasePayload,
    }).returning();
    const claimedPurchaseJobs = await claimShipmentOperationJobs({
      workerId: "worker-ambiguous-purchase",
      types: ["purchase"],
      now,
    });
    const claimedPurchase = claimedPurchaseJobs.find(
      (candidate) => candidate.id === ambiguousPurchaseJob.id,
    );
    assert.ok(claimedPurchase);
    const quotedAfterAmbiguousBuy = {
      id: ambiguousPurchaseShipment.providerShipmentId,
      order_id: ambiguousPurchaseReference,
      status: "unpaid",
      package_type: packageSnapshot.packageType,
      weight_unit: "g",
      weight: String(packageSnapshot.totalWeightGrams),
      size_unit: "cm",
      size_x: packageSnapshot.lengthCm,
      size_y: packageSnapshot.widthCm,
      size_z: packageSnapshot.heightCm,
      signature_requested: false,
      ship_date: purchasePayload.shipDate,
    };
    const ambiguousPurchaseCounters = {
      buys: 0,
      creates: 0,
      finds: 0,
      gets: 0,
      deletes: 0,
      getResult: quotedAfterAmbiguousBuy,
    };
    const ambiguousPurchaseResult = await processClaimedShipmentOperation(
      claimedPurchase,
      {
        client: clientFor(quotedAfterAmbiguousBuy, ambiguousPurchaseCounters),
        workerId: "worker-ambiguous-purchase",
        now: () => now,
      },
    );
    assert.equal(ambiguousPurchaseResult, "deadLettered");
    assert.equal(ambiguousPurchaseCounters.gets, 1);
    assert.equal(
      ambiguousPurchaseCounters.buys,
      0,
      "an ambiguous buy must never buy again when GET still reports a quote",
    );
    const ambiguousPurchaseAfter = await db.query.productShipments.findFirst({
      where: eq(productShipments.id, ambiguousPurchaseShipment.id),
    });
    const ambiguousPurchaseJobAfter = await db.query.productShipmentJobs.findFirst({
      where: eq(productShipmentJobs.id, ambiguousPurchaseJob.id),
    });
    assert.equal(ambiguousPurchaseAfter.status, "manual_review");
    assert.equal(ambiguousPurchaseJobAfter.status, "dead_letter");
    assert.equal(
      ambiguousPurchaseJobAfter.outcomeCode,
      "purchase_ambiguous_without_provider_evidence",
    );
  } finally {
    if (shipmentIds.length) {
      await db.delete(productShipmentJobs).where(
        inArray(productShipmentJobs.shipmentId, shipmentIds),
      );
      await db.delete(productShipments).where(
        inArray(productShipments.id, shipmentIds),
      );
    }
    await closePrivateDbPool();
  }
`;

test(
  "created provider drafts are persisted and cleaned up when quote context changes",
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

const rejectionScenario = String.raw`
  import assert from "node:assert/strict";
  import { eq } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    productShipmentJobs,
    productShipments,
  } from "./src/lib/private-db/schema.ts";
  import { claimShipmentOperationJobs } from "./src/lib/shipping/shipment-store.ts";
  import { processClaimedShipmentOperation } from "./src/lib/shipping/operation-worker.ts";
  import { ChitChatsApiError } from "./src/lib/shipping/chitchats-client.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";
  process.env.CHITCHATS_ACCESS_TOKEN = "operation-worker-test-token";
  process.env.CHITCHATS_CHECKOUT_ENABLED = "true";
  process.env.CHITCHATS_CLIENT_ID = "operation-worker-test-client";
  process.env.CHITCHATS_ENVIRONMENT = "staging";
  process.env.CHITCHATS_QUOTE_SIGNING_SECRET = "operation-worker-test-signing-secret-32-bytes";
  process.env.CHITCHATS_REGION = "ontario_manitoba";
  process.env.CHITCHATS_SHIPPING_ENABLED = "true";

  const db = getPrivateDb();
  const now = new Date();
  const publicReference = "lh-create-rejected-" + crypto.randomUUID();
  const [shipment] = await db.insert(productShipments).values({
    publicReference,
    quoteTokenHash: publicReference + "-token",
    quoteFingerprint: publicReference + "-fingerprint",
    status: "quote_pending",
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
    quoteExpiresAt: new Date(now.getTime() + 60 * 60_000),
  }).returning();

  const [job] = await db.insert(productShipmentJobs).values({
    shipmentId: shipment.id,
    type: "create",
    status: "queued",
    idempotencyKey: publicReference + "-create",
    availableAt: new Date(now.getTime() - 1_000),
    payload: {
      expectedShipmentStateVersion: shipment.stateVersion,
      merchandiseValueCents: 1_000,
      signatureRequested: false,
    },
  }).returning();

  const [claimedJob] = await claimShipmentOperationJobs({
    workerId: "worker-create-rejected",
    types: ["create"],
    now,
  });
  assert.ok(claimedJob);

  try {
    const result = await processClaimedShipmentOperation(claimedJob, {
      client: {
        async createShipment() {
          throw new ChitChatsApiError(
            "Chit Chats request failed with 400",
            400,
            null,
            {
              error: {
                message:
                  "(Line Item 1) Manufacturer contact is too long (maximum is 35 characters). See https://chitchats.com/help?token=secret",
              },
            },
          );
        },
        async getShipment() { throw new Error("unexpected getShipment"); },
        async findShipments() { return []; },
        async refreshShipment() { throw new Error("unexpected refreshShipment"); },
        async buyShipment() { throw new Error("unexpected buyShipment"); },
        async deleteShipment() {},
        async refundShipment() { throw new Error("unexpected refundShipment"); },
        async listReturns() { return []; },
      },
      workerId: "worker-create-rejected",
      now: () => now,
      assertQuoteContextCurrent: async () => {},
    });
    assert.equal(result, "deadLettered");

    const persisted = await db.query.productShipmentJobs.findFirst({
      where: eq(productShipmentJobs.id, job.id),
    });
    assert.equal(persisted.status, "dead_letter");
    assert.equal(persisted.outcomeCode, "create_rejected");
    // The provider rejection body is persisted for diagnosability...
    assert.match(persisted.lastError ?? "", /Manufacturer contact is too long/);
    assert.match(persisted.lastError ?? "", /Chit Chats request failed with 400/);
    // ...with signed URLs redacted before storage.
    assert.equal((persisted.lastError ?? "").includes("https://"), false);
    assert.match(persisted.lastError ?? "", /\[url\]/);

    const persistedShipment = await db.query.productShipments.findFirst({
      where: eq(productShipments.id, shipment.id),
    });
    assert.equal(persistedShipment.status, "manual_review");
  } finally {
    await db.delete(productShipmentJobs).where(
      eq(productShipmentJobs.shipmentId, shipment.id),
    );
    await db.delete(productShipments).where(
      eq(productShipments.id, shipment.id),
    );
    await closePrivateDbPool();
  }
`;

test(
  "provider create rejections dead-letter with the redacted provider body in last_error",
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
        rejectionScenario,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit",
      },
    );
  },
);
