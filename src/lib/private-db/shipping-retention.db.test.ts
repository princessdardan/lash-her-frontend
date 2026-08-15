import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run DB-backed shipping retention tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, like, sql } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import { checkoutOrders, customerEmailOutbox, orderPaymentObligations, productShipmentEvents, productShipmentJobs, productShipments } from "./src/lib/private-db/schema.ts";
  import { redactShippingPolicyPii } from "./src/lib/private-db/shipping-retention.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const db = getPrivateDb();
  const orderReference = "lh-remediation-retention-old";

  async function cleanup() {
    await db.delete(customerEmailOutbox).where(
      eq(customerEmailOutbox.providerIdempotencyKey, "retention-customer-email"),
    );
    await db.delete(orderPaymentObligations).where(
      eq(orderPaymentObligations.idempotencyKey, "retention-primary-obligation"),
    );
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
      piiRedactionDueAt: new Date("2026-07-01T12:00:00.000Z"),
      updatedAt: createdAt,
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
      piiRedactionDueAt: new Date("2026-07-01T12:00:00.000Z"),
      updatedAt: createdAt,
    }).returning({ id: productShipments.id });
    const [obligation] = await db.insert(orderPaymentObligations).values({
      orderId: order.id,
      purpose: "primary",
      status: "pending",
      merchandiseAmountCents: 2000,
      shippingAmountCents: 500,
      taxAmountCents: 0,
      totalAmountCents: 2500,
      currency: "CAD",
      sourceWorkflow: "retention_test",
      taxPolicyVersion: "retention-tax-v1",
      policyVersion: "retention-policy-v1",
      initializationStatus: "failed",
      initializationOutcome: "manual_review",
      initializationLastError: "raw provider reconciliation evidence",
      idempotencyKey: "retention-primary-obligation",
      createdAt,
      piiRedactionDueAt: new Date("2026-07-01T12:00:00.000Z"),
      updatedAt: createdAt,
    }).returning({ id: orderPaymentObligations.id });
    const [event] = await db.insert(productShipmentEvents).values({
      shipmentId: shipment.id,
      fingerprint: "retention-event-fingerprint",
      normalizedStatus: "in_transit",
      description: "Private carrier note",
      payload: { address: "123 Private Street" },
      occurredAt: createdAt,
      createdAt,
      piiRedactionDueAt: new Date("2026-07-01T12:00:00.000Z"),
    }).returning({ id: productShipmentEvents.id });
    const [job] = await db.insert(productShipmentJobs).values({
      shipmentId: shipment.id,
      type: "tracking",
      idempotencyKey: "retention-job-idempotency",
      payload: { address: "123 Private Street" },
      lastError: "Private provider error",
      createdAt,
      updatedAt: createdAt,
      piiRedactionDueAt: new Date("2026-07-01T12:00:00.000Z"),
    }).returning({ id: productShipmentJobs.id });
    const [outbox] = await db.insert(customerEmailOutbox).values({
      orderId: order.id,
      kind: "shipping_customer_update",
      recipientCiphertext: "encrypted-recipient-pii",
      templateDataCiphertext: "encrypted-template-pii",
      providerIdempotencyKey: "retention-customer-email",
      status: "dead_letter",
      lastError: "Private delivery error",
      redactionDueAt: new Date("2026-07-01T12:00:00.000Z"),
      createdAt,
      updatedAt: createdAt,
    }).returning({ id: customerEmailOutbox.id });

    await db.update(checkoutOrders).set({
      redactedAt: new Date("2026-07-02T12:00:00.000Z"),
    }).where(eq(checkoutOrders.id, order.id));

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
    const [redactedEvent] = await db.select().from(productShipmentEvents).where(eq(productShipmentEvents.id, event.id));
    assert.equal(redactedEvent.description, null);
    assert.equal(redactedEvent.payload, null);
    assert.ok(redactedEvent.redactedAt instanceof Date);
    const [redactedJob] = await db.select().from(productShipmentJobs).where(eq(productShipmentJobs.id, job.id));
    assert.equal(redactedJob.payload, null);
    assert.equal(redactedJob.lastError, null);
    assert.ok(redactedJob.redactedAt instanceof Date);
    const [redactedEmail] = await db.select().from(customerEmailOutbox).where(
      eq(customerEmailOutbox.id, outbox.id),
    );
    assert.equal(redactedEmail.recipientCiphertext, "[redacted]");
    assert.equal(redactedEmail.templateDataCiphertext, "[redacted]");
    assert.equal(redactedEmail.lastError, null);
    assert.ok(redactedEmail.redactedAt instanceof Date);
    const [redactedObligation] = await db.select({
      initializationLastError: orderPaymentObligations.initializationLastError,
      redactedAt: orderPaymentObligations.redactedAt,
    }).from(orderPaymentObligations).where(eq(orderPaymentObligations.id, obligation.id));
    assert.equal(redactedObligation.initializationLastError, null);
    assert.ok(redactedObligation.redactedAt instanceof Date);
    await assert.rejects(
      db.update(productShipments).set({
        piiRedactionDueAt: new Date("2027-07-01T12:00:00.000Z"),
      }).where(eq(productShipments.id, shipment.id)),
      (error) => {
        assert.match(error?.cause?.message ?? String(error), /immutable/);
        return true;
      },
    );
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
      [
        "--conditions=react-server",
        "--input-type=module",
        "--import",
        "tsx",
        "--eval",
        scenario,
      ],
      { cwd: process.cwd(), env: process.env, stdio: "pipe" },
    );
  },
);

const evidenceIntegrityScenario = String.raw`
  import assert from "node:assert/strict";
  import { eq } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    adminUsers,
    checkoutOrders,
    productOrderCustomerDecisions,
    productOrderRefunds,
    productShipmentJobs,
    productShipmentReturnObservations,
    productShipments,
  } from "./src/lib/private-db/schema.ts";
  import { assertShippingPiiHardCaps } from "./src/lib/private-db/shipping-retention.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const db = getPrivateDb();
  const ids = {
    order: "60600000-0000-4000-8000-000000000060",
    shipment: "61600000-0000-4000-8000-000000000060",
    decision: "62600000-0000-4000-8000-000000000060",
    refund: "63600000-0000-4000-8000-000000000060",
    job: "64600000-0000-4000-8000-000000000060",
    returnObservation: "65600000-0000-4000-8000-000000000060",
    admin: "66600000-0000-4000-8000-000000000060",
  };
  const dueAt = new Date("2025-07-01T00:00:00.000Z");
  const redactedAt = new Date("2025-07-02T00:00:00.000Z");
  const actionAt = new Date("2026-08-15T12:00:00.000Z");
  const now = new Date("2026-08-15T13:00:00.000Z");

  async function cleanup() {
    await db.delete(productShipmentReturnObservations).where(eq(productShipmentReturnObservations.id, ids.returnObservation));
    await db.delete(productShipmentJobs).where(eq(productShipmentJobs.id, ids.job));
    await db.delete(productOrderCustomerDecisions).where(eq(productOrderCustomerDecisions.id, ids.decision));
    await db.delete(productOrderRefunds).where(eq(productOrderRefunds.id, ids.refund));
    await db.delete(productShipments).where(eq(productShipments.id, ids.shipment));
    await db.delete(checkoutOrders).where(eq(checkoutOrders.id, ids.order));
    await db.delete(adminUsers).where(eq(adminUsers.id, ids.admin));
  }

  async function rejectsCheck(promise, constraintName) {
    await assert.rejects(promise, (error) => {
      assert.match(error?.cause?.message ?? String(error), new RegExp(constraintName));
      return true;
    });
  }

  try {
    await cleanup();
    await db.insert(adminUsers).values({
      id: ids.admin,
      providerUserId: "retention-evidence-admin-0060",
      email: "retention-evidence-0060@example.invalid",
      emailNormalized: "retention-evidence-0060@example.invalid",
      displayName: "Retention Evidence Admin",
      role: "owner",
    });
    await db.insert(checkoutOrders).values({
      id: ids.order,
      orderId: "lh-retention-evidence-0060",
      purpose: "product",
      status: "paid",
      customerName: "Retention Evidence Customer",
      customerEmail: "retention-evidence@example.invalid",
      amountCents: 2500,
      merchandiseAmountCents: 2000,
      shippingAmountCents: 500,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "helcim",
      paymentRiskStatus: "review_required",
      fulfillmentMode: "automated_shipping",
      piiRedactionDueAt: new Date("2027-08-15T00:00:00.000Z"),
    });
    await db.insert(productShipments).values({
      id: ids.shipment,
      orderId: ids.order,
      publicReference: "lh-retention-evidence-shipment-0060",
      quoteTokenHash: "redacted:" + ids.shipment,
      quoteFingerprint: "retention-evidence-fingerprint-0060",
      status: "manual_review",
      destination: {
        line1: "[redacted]",
        city: "[redacted]",
        province: "--",
        postalCode: "[redacted]",
        country: "[redacted]",
      },
      packageSnapshot: {
        profileId: "retention-evidence-package",
        profileSlug: "retention-evidence-package",
        packageType: "parcel",
        lengthCm: 20,
        widthCm: 15,
        heightCm: 5,
        tareWeightGrams: 50,
        totalWeightGrams: 300,
      },
      customsLines: [],
      rates: [],
      quoteExpiresAt: new Date("2025-07-01T00:15:00.000Z"),
      piiRedactionDueAt: dueAt,
      redactedAt,
    });
    await db.insert(productOrderCustomerDecisions).values({
      id: ids.decision,
      orderId: ids.order,
      shipmentId: ids.shipment,
      kind: "wait_extension",
      scopeKey: "retention-evidence-0060",
      proposedConditionsHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      allowedOutcomes: ["wait"],
      tokenHash: "redacted:" + ids.decision,
      expiresAt: new Date("2026-08-16T00:00:00.000Z"),
      piiRedactionDueAt: dueAt,
      redactedAt,
    });
    await db.insert(productOrderRefunds).values({
      id: ids.refund,
      orderId: ids.order,
      idempotencyKey: "67600000-0000-4000-8000-000000000060",
      kind: "partial",
      reason: "[redacted]",
      amountCents: 100,
      originalTransactionId: "retention-evidence-transaction-0060",
      status: "manual_review",
      piiRedactionDueAt: dueAt,
      redactedAt,
    });
    await db.insert(productShipmentJobs).values({
      id: ids.job,
      shipmentId: ids.shipment,
      type: "tracking",
      status: "dead_letter",
      idempotencyKey: "retention-evidence-job-0060",
      piiRedactionDueAt: dueAt,
      redactedAt,
    });
    await db.insert(productShipmentReturnObservations).values({
      id: ids.returnObservation,
      providerReturnId: "redacted:" + ids.returnObservation,
      shipmentId: ids.shipment,
      matchStatus: "manual_review",
      observedAt: dueAt,
      stateVersion: 2,
      redactionDueAt: dueAt,
      redactedAt,
    });

    await rejectsCheck(
      db.update(productOrderCustomerDecisions).set({
        legalFollowUpEvidenceReference: "case://0060",
        legalFollowUpRationale: "Documented rationale",
        legalFollowUpByAdminUserId: ids.admin,
      }).where(eq(productOrderCustomerDecisions.id, ids.decision)),
      "product_order_customer_decisions_legal_follow_up_evidence_check",
    );
    await rejectsCheck(
      db.update(productOrderRefunds).set({
        manualReviewEvidenceReference: "case://0060",
        manualReviewRationale: "Documented rationale",
        manualReviewByAdminUserId: ids.admin,
      }).where(eq(productOrderRefunds.id, ids.refund)),
      "product_order_refunds_manual_review_evidence_check",
    );
    await rejectsCheck(
      db.update(productShipmentJobs).set({
        reconciliationEvidenceReference: "case://0060",
        reconciliationRationale: "Documented rationale",
        reconciliationRequestedByAdminUserId: ids.admin,
      }).where(eq(productShipmentJobs.id, ids.job)),
      "product_shipment_jobs_reconciliation_evidence_check",
    );
    await rejectsCheck(
      db.update(productShipmentReturnObservations).set({
        adminResolutionAction: "record_inspection",
        adminResolutionEvidenceReference: "case://0060",
        adminResolutionRationale: "Documented rationale",
        resolvedByAdminUserId: ids.admin,
      }).where(eq(productShipmentReturnObservations.id, ids.returnObservation)),
      "product_shipment_returns_admin_resolution_check",
    );
    await rejectsCheck(
      db.update(productShipments).set({
        manualReviewAcknowledgedAt: actionAt,
        manualReviewEvidenceReference: "case://0060",
        manualReviewRationale: "Documented rationale",
        manualReviewByAdminUserId: ids.admin,
      }).where(eq(productShipments.id, ids.shipment)),
      "product_shipments_manual_review_evidence_check",
    );

    const absoluteCases = [
      {
        name: "customer-decision legal evidence",
        apply: () => db.update(productOrderCustomerDecisions).set({
          legalFollowUpEvidenceReference: "case://0060",
          legalFollowUpRationale: "Documented rationale",
          legalFollowUpByAdminUserId: ids.admin,
          legalFollowUpStepUpAuthenticatedAt: actionAt,
          legalFollowUpRecordedAt: actionAt,
        }).where(eq(productOrderCustomerDecisions.id, ids.decision)),
        clear: () => db.update(productOrderCustomerDecisions).set({
          legalFollowUpEvidenceReference: null,
          legalFollowUpRationale: null,
          legalFollowUpByAdminUserId: null,
          legalFollowUpStepUpAuthenticatedAt: null,
          legalFollowUpRecordedAt: null,
        }).where(eq(productOrderCustomerDecisions.id, ids.decision)),
      },
      {
        name: "refund manual-review evidence",
        apply: () => db.update(productOrderRefunds).set({
          manualReviewEvidenceReference: "case://0060",
          manualReviewRationale: "Documented rationale",
          manualReviewByAdminUserId: ids.admin,
          manualReviewStepUpAuthenticatedAt: actionAt,
          manualReviewRecordedAt: actionAt,
        }).where(eq(productOrderRefunds.id, ids.refund)),
        clear: () => db.update(productOrderRefunds).set({
          manualReviewEvidenceReference: null,
          manualReviewRationale: null,
          manualReviewByAdminUserId: null,
          manualReviewStepUpAuthenticatedAt: null,
          manualReviewRecordedAt: null,
        }).where(eq(productOrderRefunds.id, ids.refund)),
      },
      {
        name: "shipment-job reconciliation evidence",
        apply: () => db.update(productShipmentJobs).set({
          reconciliationEvidenceReference: "case://0060",
          reconciliationRationale: "Documented rationale",
          reconciliationRequestedByAdminUserId: ids.admin,
          reconciliationStepUpAuthenticatedAt: actionAt,
          reconciliationRequestedAt: actionAt,
        }).where(eq(productShipmentJobs.id, ids.job)),
        clear: () => db.update(productShipmentJobs).set({
          reconciliationEvidenceReference: null,
          reconciliationRationale: null,
          reconciliationRequestedByAdminUserId: null,
          reconciliationStepUpAuthenticatedAt: null,
          reconciliationRequestedAt: null,
        }).where(eq(productShipmentJobs.id, ids.job)),
      },
      {
        name: "return-resolution evidence",
        apply: () => db.update(productShipmentReturnObservations).set({
          adminResolutionAction: "record_inspection",
          adminResolutionEvidenceReference: "case://0060",
          adminResolutionRationale: "Documented rationale",
          resolvedByAdminUserId: ids.admin,
          resolutionStepUpAuthenticatedAt: actionAt,
          resolvedAt: actionAt,
          resolvedStateVersion: 2,
        }).where(eq(productShipmentReturnObservations.id, ids.returnObservation)),
        clear: () => db.update(productShipmentReturnObservations).set({
          adminResolutionAction: null,
          adminResolutionEvidenceReference: null,
          adminResolutionRationale: null,
          resolvedByAdminUserId: null,
          resolutionStepUpAuthenticatedAt: null,
          resolvedAt: null,
          resolvedStateVersion: null,
        }).where(eq(productShipmentReturnObservations.id, ids.returnObservation)),
      },
      {
        name: "shipment manual-review evidence",
        apply: () => db.update(productShipments).set({
          manualReviewAcknowledgedAt: actionAt,
          manualReviewEvidenceReference: "case://0060",
          manualReviewRationale: "Documented rationale",
          manualReviewByAdminUserId: ids.admin,
          manualReviewStepUpAuthenticatedAt: actionAt,
        }).where(eq(productShipments.id, ids.shipment)),
        clear: () => db.update(productShipments).set({
          manualReviewEvidenceReference: null,
          manualReviewRationale: null,
          manualReviewByAdminUserId: null,
          manualReviewStepUpAuthenticatedAt: null,
        }).where(eq(productShipments.id, ids.shipment)),
      },
    ];

    for (const absoluteCase of absoluteCases) {
      await absoluteCase.apply();
      let absoluteError;
      try {
        await db.transaction((tx) => assertShippingPiiHardCaps(tx, now));
      } catch (error) {
        absoluteError = error;
      }
      assert.ok(
        absoluteError,
        absoluteCase.name + " must fail the day-395 absolute-cap verifier",
      );
      assert.match(String(absoluteError), /395-day absolute cap/);
      await absoluteCase.clear();
    }
  } finally {
    await cleanup();
    await closePrivateDbPool();
  }
`;

test(
  "0060 rejects partial evidence bundles and day-395 detects leftover evidence",
  { skip: dbTestSkipReason },
  () => {
    execFileSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--input-type=module",
        "--import",
        "tsx",
        "--eval",
        evidenceIntegrityScenario,
      ],
      { cwd: process.cwd(), env: process.env, stdio: "pipe" },
    );
  },
);

const unresolvedRefundScenario = String.raw`
  import assert from "node:assert/strict";
  import { eq, inArray, sql } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import { checkoutOrders, productOrderRefunds } from "./src/lib/private-db/schema.ts";
  import { markCheckoutOrderPrivacyTerminalIfEligible, redactShippingPolicyPii } from "./src/lib/private-db/shipping-retention.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const db = getPrivateDb();
  const references = [
    "lh-retention-failed-refund",
    "lh-retention-manual-refund",
    "lh-retention-unknown-refund",
    "lh-retention-manual-pickup-pending",
    "lh-retention-explicitly-terminal",
  ];

  async function cleanup() {
    const orders = await db.select({ id: checkoutOrders.id })
      .from(checkoutOrders)
      .where(inArray(checkoutOrders.orderId, references));
    if (orders.length) {
      await db.delete(productOrderRefunds).where(
        inArray(productOrderRefunds.orderId, orders.map((order) => order.id)),
      );
    }
    await db.delete(checkoutOrders).where(inArray(checkoutOrders.orderId, references));
  }

  try {
    await cleanup();
    const createdAt = new Date("2025-12-01T12:00:00.000Z");
    const dueAt = new Date("2026-12-01T12:00:00.000Z");
    const statuses = ["failed", "manual_review", "outcome_unknown"];
    for (let index = 0; index < statuses.length; index += 1) {
      const [order] = await db.insert(checkoutOrders).values({
        orderId: references[index],
        purpose: "product",
        status: "paid",
        customerName: "Unresolved Refund Customer",
        customerEmail: "unresolved-refund@example.invalid",
        amountCents: 2500,
        merchandiseAmountCents: 2000,
        shippingAmountCents: 500,
        currency: "CAD",
        lineItems: [],
        paymentProvider: "helcim",
        paymentRiskStatus: "cleared",
        fulfillmentMode: "automated_shipping",
        createdAt,
        updatedAt: createdAt,
        piiRedactionDueAt: dueAt,
      }).returning({ id: checkoutOrders.id });
      await db.insert(productOrderRefunds).values({
        orderId: order.id,
        idempotencyKey: crypto.randomUUID(),
        kind: "full",
        reason: "Required customer remedy",
        amountCents: 2500,
        originalTransactionId: "retention-transaction-" + index,
        status: statuses[index],
        createdAt,
        updatedAt: createdAt,
        piiRedactionDueAt: dueAt,
      });
    }
    const [manualPending] = await db.insert(checkoutOrders).values({
      orderId: references[3],
      purpose: "product",
      status: "paid",
      customerName: "Pending Pickup Customer",
      customerEmail: "pending-pickup@example.invalid",
      amountCents: 2500,
      merchandiseAmountCents: 2500,
      shippingAmountCents: 0,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "helcim",
      paymentRiskStatus: "cleared",
      fulfillmentMode: "manual_pickup",
      manualFulfillmentStatus: "paid_pending_dispatch",
      createdAt,
      updatedAt: createdAt,
      piiRedactionDueAt: dueAt,
    }).returning({ id: checkoutOrders.id });
    await db.insert(checkoutOrders).values({
      orderId: references[4],
      purpose: "product",
      status: "paid",
      customerName: "Terminal Customer",
      customerEmail: "terminal@example.invalid",
      amountCents: 2500,
      merchandiseAmountCents: 2500,
      shippingAmountCents: 0,
      currency: "CAD",
      lineItems: [],
      paymentProvider: "helcim",
      paymentRiskStatus: "cleared",
      fulfillmentMode: "manual_pickup",
      manualFulfillmentStatus: "dispatched",
      createdAt,
      updatedAt: createdAt,
      piiRedactionDueAt: dueAt,
      privacyTerminalAt: createdAt,
    });

    assert.equal(
      await markCheckoutOrderPrivacyTerminalIfEligible({
        orderId: manualPending.id,
        now: new Date("2026-08-14T16:00:00.000Z"),
      }),
      false,
    );

    await redactShippingPolicyPii(new Date("2026-08-14T16:00:00.000Z"));
    const blocked = await db.select({
      customerEmail: checkoutOrders.customerEmail,
      redactedAt: checkoutOrders.redactedAt,
    }).from(checkoutOrders).where(inArray(checkoutOrders.orderId, references));
    assert.equal(blocked.length, 5);
    assert.equal(
      blocked.filter((row) => row.redactedAt === null).length,
      4,
    );
    assert.ok(
      blocked.some(
        (row) =>
          row.customerEmail === "pending-pickup@example.invalid" &&
          row.redactedAt === null,
      ),
    );
    assert.ok(
      blocked.some(
        (row) =>
          row.customerEmail === "[redacted]" && row.redactedAt instanceof Date,
      ),
    );

    await redactShippingPolicyPii(new Date("2027-01-02T16:00:00.000Z"));
    const hardCapRedacted = await db.select({
      customerEmail: checkoutOrders.customerEmail,
      redactedAt: checkoutOrders.redactedAt,
    }).from(checkoutOrders).where(inArray(checkoutOrders.orderId, references));
    assert.ok(hardCapRedacted.every((row) => row.customerEmail === "[redacted]"));
    assert.ok(hardCapRedacted.every((row) => row.redactedAt instanceof Date));
  } finally {
    await cleanup();
    await closePrivateDbPool();
  }
`;

test(
  "failed and unresolved customer refunds block day-180 redaction but not the day-365 hard cap",
  { skip: dbTestSkipReason },
  () => {
    execFileSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--input-type=module",
        "--import",
        "tsx",
        "--eval",
        unresolvedRefundScenario,
      ],
      { cwd: process.cwd(), env: process.env, stdio: "pipe" },
    );
  },
);
