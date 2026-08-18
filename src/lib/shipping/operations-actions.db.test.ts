import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run operations action concurrency tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { and, eq, sql } from "drizzle-orm";
  import { returnObservationNeedsReviewSql } from "./src/lib/admin/operations-workspaces.ts";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    adminUsers,
    productShipmentJobs,
    productShipmentReturnObservations,
    productShipments,
  } from "./src/lib/private-db/schema.ts";
  import {
    recordFulfillmentOperationReview,
    resolveReturnObservation,
  } from "./src/lib/shipping/operations-actions.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";
  const db = getPrivateDb();
  const fixture = crypto.randomUUID();
  let ownerId;
  let shipmentId;
  let jobId;
  let observationId;

  try {
    const email = "operations-actions-" + fixture + "@example.invalid";
    const [owner] = await db.insert(adminUsers).values({
      providerUserId: "operations-actions-owner-" + fixture,
      email,
      emailNormalized: email,
      role: "owner",
      status: "active",
    }).returning({ id: adminUsers.id });
    ownerId = owner.id;
    process.env.ADMIN_OWNER_EMAILS = email;

    const [shipment] = await db.insert(productShipments).values({
      publicReference: "operations-actions-shipment-" + fixture,
      quoteTokenHash: "operations-actions-token-" + fixture,
      quoteFingerprint: "operations-actions-fingerprint-" + fixture,
      status: "manual_review",
      destination: { name: "Test", email: "test@example.invalid", phone: "+14165550100", line1: "1 Test St", city: "Toronto", province: "ON", postalCode: "M5V 1A1", country: "Canada", countryCode: "CA" },
      packageSnapshot: { profileId: "test", profileSlug: "test", packageType: "parcel", lengthCm: 10, widthCm: 10, heightCm: 10, tareWeightGrams: 10, totalWeightGrams: 100 },
      customsLines: [],
      rates: [],
      quoteExpiresAt: new Date(Date.now() + 60_000),
    }).returning();
    shipmentId = shipment.id;
    const [job] = await db.insert(productShipmentJobs).values({
      shipmentId,
      type: "purchase",
      status: "dead_letter",
      idempotencyKey: "operations-actions-job-" + fixture,
      outcomeUnknown: true,
      outcomeCode: "provider_mutation_outcome_unknown",
    }).returning();
    jobId = job.id;

    const inputs = [0, 1].map(() => recordFulfillmentOperationReview({
      actorAdminUserId: ownerId,
      evidenceReference: "provider-case-123",
      expectedStateVersion: job.stateVersion,
      id: job.id,
      kind: "provider_job",
      rationale: "Provider evidence requires an identity-first reconciliation pass.",
      stepUpAuthenticatedAt: new Date(),
    }));
    const results = await Promise.allSettled(inputs);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const [requeued] = await db.select().from(productShipmentJobs).where(eq(productShipmentJobs.id, job.id));
    assert.equal(requeued.status, "queued");
    assert.equal(requeued.outcomeUnknown, true);
    assert.equal(requeued.outcomeCode, "manual_reconciliation_requested");
    assert.equal(requeued.reconciliationEvidenceReference, "provider-case-123");
    assert.equal(requeued.stateVersion, job.stateVersion + 1);

    const [observation] = await db.insert(productShipmentReturnObservations).values({
      providerReturnId: "operations-actions-return-" + fixture,
      shipmentId,
      providerShipmentId: "provider-shipment-" + fixture,
      matchStatus: "matched",
      providerStatus: "returned",
      returnReason: "damaged",
      observedAt: new Date(),
    }).returning();
    observationId = observation.id;
    const returnResults = await Promise.allSettled([0, 1].map(() =>
      resolveReturnObservation({
        action: "record_inspection",
        actorAdminUserId: ownerId,
        evidenceReference: "inspection-report-123",
        expectedStateVersion: observation.stateVersion,
        id: observation.id,
        rationale: "The matched returned parcel was inspected and documented.",
        stepUpAuthenticatedAt: new Date(),
      }),
    ));
    assert.equal(returnResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(returnResults.filter((result) => result.status === "rejected").length, 1);
    const [resolved] = await db.select().from(productShipmentReturnObservations).where(eq(productShipmentReturnObservations.id, observation.id));
    assert.equal(resolved.adminResolutionAction, "record_inspection");
    assert.ok(resolved.resolvedAt);
    assert.equal(resolved.stateVersion, observation.stateVersion + 1);
    assert.equal(resolved.resolvedStateVersion, resolved.stateVersion);

    const currentReviewRows = await db
      .select({ id: productShipmentReturnObservations.id })
      .from(productShipmentReturnObservations)
      .where(and(
        eq(productShipmentReturnObservations.id, observation.id),
        returnObservationNeedsReviewSql("product_shipment_return_observations"),
      ));
    assert.equal(currentReviewRows.length, 0);

    await db.update(productShipmentReturnObservations).set({
      providerStatus: "provider_evidence_updated",
      stateVersion: sql.raw("state_version + 1"),
      updatedAt: new Date(),
    }).where(eq(productShipmentReturnObservations.id, observation.id));
    const changedReviewRows = await db
      .select({
        id: productShipmentReturnObservations.id,
        action: productShipmentReturnObservations.adminResolutionAction,
        evidence: productShipmentReturnObservations.adminResolutionEvidenceReference,
      })
      .from(productShipmentReturnObservations)
      .where(and(
        eq(productShipmentReturnObservations.id, observation.id),
        returnObservationNeedsReviewSql("product_shipment_return_observations"),
      ));
    assert.equal(changedReviewRows.length, 1);
    assert.equal(changedReviewRows[0].action, "record_inspection");
    assert.equal(changedReviewRows[0].evidence, "inspection-report-123");
  } finally {
    if (observationId) await db.delete(productShipmentReturnObservations).where(eq(productShipmentReturnObservations.id, observationId));
    if (jobId) await db.delete(productShipmentJobs).where(eq(productShipmentJobs.id, jobId));
    if (shipmentId) await db.delete(productShipments).where(eq(productShipments.id, shipmentId));
    if (ownerId) {
      await db.delete(adminUsers).where(eq(adminUsers.id, ownerId));
    }
    await closePrivateDbPool();
  }
`;

test(
  "operation reviews use CAS and never duplicate reconciliation or return resolution",
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
