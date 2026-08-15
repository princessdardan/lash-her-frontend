import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run manual checkout readiness DB tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { createHash, randomBytes, randomUUID } from "node:crypto";
  import { eq } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    adminUsers,
    fulfillmentPolicyVersions,
    fulfillmentProviderCertifications,
    manualFulfillmentPolicyVersions,
    productTaxPolicyVersions,
    shippingPolicyAssignments,
  } from "./src/lib/private-db/schema.ts";
  import {
    assertManualCheckoutReadinessInTransaction,
    evaluateManualCheckoutReadiness,
  } from "./src/lib/shipping/readiness.ts";
  import { certifyFulfillmentProvider } from "./src/lib/shipping/policy-admin.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";

  const db = getPrivateDb();
  const suffix = randomUUID();
  const now = new Date("2026-08-15T16:00:00.000Z");
  const readinessNow = new Date(now.getTime() + 120_000);
  const approvedAt = new Date(now.getTime() - 120_000);
  const effectiveAt = new Date(now.getTime() - 60_000);
  const policyText = "Approved manual cancellation and refund policy " + suffix;
  const policyTextHash = createHash("sha256").update(policyText, "utf8").digest("hex");
  const ownerEmail = "manual-readiness-" + suffix + "@example.invalid";
  const taxEvidenceHash = createHash("sha256")
      .update("manual-readiness-tax-evidence/" + suffix, "utf8")
      .digest("hex");
  const providerEvidenceHash = createHash("sha256")
      .update("manual-readiness-provider-evidence/" + suffix, "utf8")
      .digest("hex");
  const helcimContract = {
    contract: "helcim_product_payments",
    version: "manual-readiness-helcim-" + suffix,
    evidenceReference: "test://manual-readiness/helcim/" + suffix,
    effectiveFrom: new Date(now.getTime() + 60_000).toISOString(),
    effectiveUntil: new Date(now.getTime() + 86_400_000).toISOString(),
    purchaseTransactionTypes: ["purchase"],
    refundTransactionTypes: ["refund"],
    purchaseSuccessfulStatuses: ["approved"],
    refundSuccessfulStatuses: ["approved"],
    avs: {
      fieldNames: ["avsresponse"],
      matchCodes: ["m"],
      mismatchCodes: ["n"],
    },
    cvv: {
      fieldNames: ["cvvresponse"],
      matchCodes: ["m"],
      mismatchCodes: ["n"],
    },
    refundCorrelation: {
      providerRefundIdFields: ["transactionid"],
      originalTransactionIdFields: ["originaltransactionid"],
      merchantReferenceFields: ["merchantreference"],
    },
  };
  const env = {
    ...process.env,
    MANUAL_PRODUCT_CHECKOUT_ENABLED: "true",
    SHIPPING_POLICY_ENFORCEMENT_MODE: "enforce",
    NEXT_PUBLIC_SITE_URL: "https://www.lashher.ca",
    CRON_SECRET: "0123456789abcdefghijklmnopqrstuvwxyz-CRON",
    CHECKOUT_SECRET_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    CHECKOUT_PII_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    HELCIM_GENERAL_API_TOKEN: "general-api-token-" + suffix,
    HELCIM_TRANSACTION_API_TOKEN: "transaction-api-token-" + suffix,
    HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON: JSON.stringify(helcimContract),
    ADMIN_OWNER_EMAILS: ownerEmail,
    VERCEL_ENV: "preview",
  };
  Object.assign(process.env, env);
  let adminId;
  let otherAdminId;
  let fulfillmentPolicyId;
  let taxPolicyId;
  let certificationId;
  let manualPolicyId;

  try {
    const [admin] = await db.insert(adminUsers).values({
      providerUserId: "manual-readiness-provider-" + suffix,
      email: ownerEmail,
      emailNormalized: ownerEmail,
      displayName: "Nataliea Lavoie",
      role: "owner",
    }).returning({ id: adminUsers.id });
    adminId = admin.id;
    await db.insert(shippingPolicyAssignments).values(
      [
        "business_owner",
        "operations_lead",
        "finance_owner",
        "payment_fraud_owner",
        "privacy_owner",
        "security_owner",
      ].map((duty) => ({
        duty,
        adminUserId: adminId,
        assignedByAdminUserId: adminId,
      })),
    );

    const [fulfillmentPolicy] = await db.insert(fulfillmentPolicyVersions).values({
      version: "manual-readiness-fulfillment-" + suffix,
      status: "effective",
      ownerName: "Nataliea Lavoie",
      policySnapshot: {
        ownerOnlyReview: true,
        p10TerminationNoticeDays: 350,
        p10DefaultExecutionDays: 360,
        p10HardCapDays: 365,
      },
      privacyLegalAttestedAt: approvedAt,
      securityAttestedAt: approvedAt,
      operationsAttestedAt: approvedAt,
      attestationEvidenceReference: "test://manual-readiness/fulfillment/" + suffix,
      attestedByAdminUserId: adminId,
      effectiveAt,
    }).returning({ id: fulfillmentPolicyVersions.id });
    fulfillmentPolicyId = fulfillmentPolicy.id;

    const [taxPolicy] = await db.insert(productTaxPolicyVersions).values({
      version: "manual-readiness-tax-" + suffix,
      status: "effective",
      coverage: {
        merchandise: true,
        shipping: true,
        supplements: true,
        usOrders: true,
        componentRefunds: true,
      },
      ownerName: "Nataliea Lavoie",
      evidenceReference: "test://manual-readiness/tax/" + suffix,
      approvedByAdminUserId: adminId,
      approvalStepUpAuthenticatedAt: approvedAt,
      approvalAction: "approve_product_tax_policy",
      approvalEvidenceHash: taxEvidenceHash,
      approvalEvidenceVersion: "product-tax-attestation/v1",
      approvedAt,
      effectiveAt,
    }).returning({ id: productTaxPolicyVersions.id });
    taxPolicyId = taxPolicy.id;

    const [certification] = await db.insert(fulfillmentProviderCertifications).values({
      provider: "helcim",
      environment: "staging",
      scope: "product_payments",
      version: "manual-readiness-helcim-" + suffix,
      evidenceReference: "test://manual-readiness/helcim/" + suffix,
      contractSnapshot: {
        ...helcimContract,
        purchaseSuccessfulStatuses: ["uncertified-status"],
        refundSuccessfulStatuses: ["uncertified-status"],
      },
      certifiedByOwnerName: "Nataliea Lavoie",
      certifiedByAdminUserId: adminId,
      certificationStepUpAuthenticatedAt: approvedAt,
      certificationEvidenceHash: providerEvidenceHash,
      certificationEvidenceVersion: "provider-certification/v1",
      certificationAction: "certify_fulfillment_provider",
      certifiedAt: approvedAt,
      validUntil: new Date(helcimContract.effectiveUntil),
    }).returning({ id: fulfillmentProviderCertifications.id });
    certificationId = certification.id;

    const [manualPolicy] = await db.insert(manualFulfillmentPolicyVersions).values({
      version: "manual-readiness-policy-" + suffix,
      status: "draft",
      policySnapshot: { cancellationPolicyText: policyText },
    }).returning({ id: manualFulfillmentPolicyVersions.id });
    manualPolicyId = manualPolicy.id;

    const unapproved = await evaluateManualCheckoutReadiness({
      catalogMetadataReady: true,
      env,
      now,
    });
    assert.equal(unapproved.ready, false);
    assert.equal(unapproved.policy, null);
    assert.ok(unapproved.blockers.includes("manual_policy_not_approved"));

    await assert.rejects(
      db.update(manualFulfillmentPolicyVersions)
        .set({ status: "effective", effectiveAt })
        .where(eq(manualFulfillmentPolicyVersions.id, manualPolicyId)),
      (error) => {
        assert.match(
          error?.cause?.message ?? String(error),
          /manual_fulfillment_policy_versions_effective_evidence_check/,
        );
        return true;
      },
    );

    await db.update(manualFulfillmentPolicyVersions).set({
      status: "effective",
      policyTextHash,
      evidenceReference: "test://manual-readiness/manual-policy/" + suffix,
      approvedByAdminUserId: adminId,
      approvalStepUpAuthenticatedAt: approvedAt,
      approvalEvidenceHash: policyTextHash,
      approvalEvidenceVersion: "manual-fulfillment-policy/v1",
      approvalAction: "approve_manual_fulfillment_policy",
      approvedAt,
      effectiveAt,
    }).where(eq(manualFulfillmentPolicyVersions.id, manualPolicyId));

    await db.update(productTaxPolicyVersions).set({
      ownerName: "Unconfigured Reviewer",
    }).where(eq(productTaxPolicyVersions.id, taxPolicyId));
    const forgedTaxApproval = await evaluateManualCheckoutReadiness({
      catalogMetadataReady: true,
      env,
      now,
    });
    assert.equal(forgedTaxApproval.ready, false);
    assert.ok(
      forgedTaxApproval.blockers.includes("product_tax_policy_not_approved"),
    );
    await db.update(productTaxPolicyVersions).set({
      ownerName: "Nataliea Lavoie",
    }).where(eq(productTaxPolicyVersions.id, taxPolicyId));

    const mismatchedCertification = await evaluateManualCheckoutReadiness({
      catalogMetadataReady: true,
      env,
      now,
    });
    assert.equal(mismatchedCertification.ready, false);
    assert.ok(mismatchedCertification.blockers.includes("helcim_not_certified"));
    await db.delete(fulfillmentProviderCertifications).where(
      eq(fulfillmentProviderCertifications.id, certificationId),
    );
    const exactCertification = await certifyFulfillmentProvider({
      actorAdminUserId: adminId,
      provider: "helcim",
      environment: "staging",
      scope: "product_payments",
      version: helcimContract.version,
      evidenceReference: helcimContract.evidenceReference,
      validUntil: new Date(helcimContract.effectiveUntil),
      stepUpAuthenticatedAt: approvedAt,
    }, { now });
    certificationId = exactCertification.id;
    assert.equal(exactCertification.certifiedAt.getTime(), now.getTime());

    const [otherAdmin] = await db.insert(adminUsers).values({
      providerUserId: "manual-readiness-other-" + suffix,
      email: "manual-readiness-other-" + suffix + "@example.invalid",
      emailNormalized: "manual-readiness-other-" + suffix + "@example.invalid",
      displayName: "Unconfigured Reviewer",
      role: "admin",
    }).returning({ id: adminUsers.id });
    otherAdminId = otherAdmin.id;
    await db.update(fulfillmentProviderCertifications).set({
      certifiedByAdminUserId: otherAdmin.id,
    }).where(eq(fulfillmentProviderCertifications.id, certificationId));
    const wrongProviderOwner = await evaluateManualCheckoutReadiness({
      catalogMetadataReady: true,
      env,
      now: readinessNow,
    });
    assert.equal(wrongProviderOwner.ready, false);
    assert.ok(wrongProviderOwner.blockers.includes("helcim_not_certified"));
    await db.update(fulfillmentProviderCertifications).set({
      certifiedByAdminUserId: adminId,
    }).where(eq(fulfillmentProviderCertifications.id, certificationId));

    await db.update(adminUsers).set({ role: "owner" }).where(
      eq(adminUsers.id, otherAdmin.id),
    );
    const multipleOwners = await evaluateManualCheckoutReadiness({
      catalogMetadataReady: true,
      env,
      now: readinessNow,
    });
    assert.equal(multipleOwners.ready, false);
    assert.ok(
      multipleOwners.blockers.includes("sole_owner_configuration_invalid"),
    );
    await db.update(adminUsers).set({ role: "admin" }).where(
      eq(adminUsers.id, otherAdmin.id),
    );

    const ready = await evaluateManualCheckoutReadiness({
      catalogMetadataReady: true,
      env,
      now: readinessNow,
    });
    assert.equal(ready.ready, true, ready.blockers.join(","));
    assert.equal(ready.policy?.version, "manual-readiness-policy-" + suffix);
    assert.equal(ready.policy?.textHash, policyTextHash);
    assert.equal(ready.taxPolicyVersion, "manual-readiness-tax-" + suffix);
    assert.ok(ready.fulfillmentPolicyVersion);
    assert.ok(ready.policy);
    assert.ok(ready.taxPolicyApproval);
    const expectedReadiness = {
      fulfillmentPolicyVersion: ready.fulfillmentPolicyVersion,
      manualPolicy: ready.policy,
      taxPolicyApproval: ready.taxPolicyApproval,
    };

    await db.update(manualFulfillmentPolicyVersions).set({
      status: "superseded",
      supersededAt: now,
    }).where(eq(manualFulfillmentPolicyVersions.id, manualPolicyId));
    await assert.rejects(
      db.transaction((tx) =>
        assertManualCheckoutReadinessInTransaction(tx, expectedReadiness, now),
      ),
      /Product checkout is not operationally ready/,
    );
    await db.update(manualFulfillmentPolicyVersions).set({
      status: "effective",
      supersededAt: null,
    }).where(eq(manualFulfillmentPolicyVersions.id, manualPolicyId));

    await db.update(adminUsers).set({ role: "admin" }).where(
      eq(adminUsers.id, adminId),
    );
    await assert.rejects(
      db.transaction((tx) =>
        assertManualCheckoutReadinessInTransaction(tx, expectedReadiness, now),
      ),
      /Product checkout is not operationally ready/,
    );
    await db.update(adminUsers).set({ role: "owner" }).where(
      eq(adminUsers.id, adminId),
    );
  } finally {
    if (manualPolicyId) await db.delete(manualFulfillmentPolicyVersions).where(eq(manualFulfillmentPolicyVersions.id, manualPolicyId));
    if (certificationId) await db.delete(fulfillmentProviderCertifications).where(eq(fulfillmentProviderCertifications.id, certificationId));
    if (taxPolicyId) await db.delete(productTaxPolicyVersions).where(eq(productTaxPolicyVersions.id, taxPolicyId));
    if (fulfillmentPolicyId) await db.delete(fulfillmentPolicyVersions).where(eq(fulfillmentPolicyVersions.id, fulfillmentPolicyId));
    if (adminId) await db.delete(shippingPolicyAssignments).where(eq(shippingPolicyAssignments.adminUserId, adminId));
    if (otherAdminId) await db.delete(adminUsers).where(eq(adminUsers.id, otherAdminId));
    if (adminId) await db.delete(adminUsers).where(eq(adminUsers.id, adminId));
    await closePrivateDbPool();
  }
`;

test(
  "manual checkout readiness rejects unapproved policy and accepts only complete current evidence",
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
