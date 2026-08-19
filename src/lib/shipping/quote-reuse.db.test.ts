import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run shipping quote reuse tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { eq } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    productShipmentJobs,
    productShipments,
    shippingCalendarVersions,
  } from "./src/lib/private-db/schema.ts";
  import { createQuoteOperation } from "./src/lib/shipping/shipment-store.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";
  process.env.CHITCHATS_ACCESS_TOKEN = "quote-reuse-test-token";
  process.env.CHITCHATS_CLIENT_ID = "quote-reuse-test-client";
  process.env.CHITCHATS_ENVIRONMENT = "staging";
  process.env.CHITCHATS_QUOTE_SIGNING_SECRET = "quote-reuse-test-signing-secret-32-bytes";
  process.env.CHITCHATS_REGION = "ontario_manitoba";

  const db = getPrivateDb();
  const prefix = "lh-quote-reuse-" + crypto.randomUUID();
  let calendarId;

  try {
    const [calendar] = await db.insert(shippingCalendarVersions).values({
      version: prefix + "-calendar",
      status: "draft",
      timezone: "America/Toronto",
      coverageStartsOn: "2026-01-01",
      coverageEndsOn: "2028-12-31",
      closureDates: [],
    }).returning();
    calendarId = calendar.id;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60_000);
    const quoteContextSnapshot = {
      helcimProductPaymentsContract: {
        contract: "helcim_product_payments",
        version: "helcim-product-payments-v1",
        evidenceReference: "test/helcim/product-payments/v1",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2028-01-01T00:00:00.000Z",
        purchaseTransactionTypes: ["purchase"],
        refundTransactionTypes: ["refund"],
        purchaseSuccessfulStatuses: ["approved"],
        refundSuccessfulStatuses: ["approved"],
        avs: { fieldNames: ["avsResponse"], matchCodes: ["m"], mismatchCodes: ["n"] },
        cvv: { fieldNames: ["cvvResponse"], matchCodes: ["m"], mismatchCodes: ["n"] },
        refundCorrelation: {
          providerRefundIdFields: ["transactionId"],
          originalTransactionIdFields: ["originalTransactionId"],
          merchantReferenceFields: ["merchantReference"],
        },
      },
      policyVersion: "test-policy-v1",
      region: "ontario_manitoba",
      servicePolicies: [],
      shippingPolicySnapshot: {
        afterCutoffHandoffBusinessDays: 2,
        autoRefundBusinessDays: 2,
        beforeCutoffHandoffBusinessDays: 1,
        closureDates: [],
        coverageEndsAt: "17:00:00",
        coverageStartsAt: "09:00:00",
        orderCutoff: "14:00:00",
        signatureThresholdCents: 50_000,
        timezone: "America/Toronto",
      },
      taxPolicyApproval: {
        approvalAction: "approve_product_tax_policy",
        approvalEvidenceHash: "c".repeat(64),
        approvalEvidenceVersion: "v1",
        approvalStepUpAuthenticatedAt: "2026-08-14T11:59:00.000Z",
        approvedAt: "2026-08-14T12:00:00.000Z",
        approvedByAdminUserId: "11111111-1111-4111-8111-111111111111",
        coverage: { merchandise: true, shipping: true, supplements: true, usOrders: true, componentRefunds: true },
        effectiveAt: "2026-08-14T12:00:00.000Z",
        evidenceReference: "evidence/tax/v1",
        ownerName: "Test Owner",
        version: "tax-v1",
      },
      taxPolicyVersion: "tax-v1",
      usShippingContract: null,
    };
    const base = {
      quoteFingerprint: prefix + "-fingerprint",
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
      expiresAt,
      merchandiseValueCents: 1_000,
      quoteContextSnapshot,
      signatureRequested: false,
      usShippingContractSnapshot: null,
      now,
    };
    const [first, second] = await Promise.all([
      createQuoteOperation({ ...base, publicReference: prefix + "-one" }),
      createQuoteOperation({ ...base, publicReference: prefix + "-two" }),
    ]);
    assert.equal(first.shipment.id, second.shipment.id);
    assert.equal(first.operation.id, second.operation.id);
    assert.equal(first.quoteToken, second.quoteToken);
    assert.equal([first.reused, second.reused].filter(Boolean).length, 1);
    assert.equal(
      first.shipment.quoteExpiresAt.toISOString(),
      expiresAt.toISOString(),
      "reuse must not extend the original fifteen-minute expiry",
    );
    const shipments = await db.select().from(productShipments).where(
      eq(productShipments.quoteFingerprint, base.quoteFingerprint),
    );
    const jobs = await db.select().from(productShipmentJobs).where(
      eq(productShipmentJobs.shipmentId, first.shipment.id),
    );
    assert.equal(shipments.length, 1);
    assert.equal(jobs.filter((job) => job.type === "create").length, 1);
  } finally {
    const shipments = await db.select({ id: productShipments.id }).from(productShipments).where(
      eq(productShipments.quoteFingerprint, prefix + "-fingerprint"),
    );
    for (const shipment of shipments) {
      await db.delete(productShipmentJobs).where(eq(productShipmentJobs.shipmentId, shipment.id));
      await db.delete(productShipments).where(eq(productShipments.id, shipment.id));
    }
    if (calendarId) {
      await db.delete(shippingCalendarVersions).where(eq(shippingCalendarVersions.id, calendarId));
    }
    await closePrivateDbPool();
  }
`;

test(
  "exact concurrent quote requests reuse one unexpired unattached draft",
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
