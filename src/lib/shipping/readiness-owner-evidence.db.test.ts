import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run readiness owner-evidence DB tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { createHash, randomUUID } from "node:crypto";
  import { eq } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    adminUsers,
    productTaxPolicyVersions,
    shippingPackageProfiles,
    shippingServicePolicies,
  } from "./src/lib/private-db/schema.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL.includes("?")
    ? process.env.TEST_DATABASE_URL + "&sslmode=disable"
    : process.env.TEST_DATABASE_URL + "?sslmode=disable";

  const db = getPrivateDb();
  const suffix = randomUUID();
  const reviewedAt = new Date("2026-08-15T12:00:00.000Z");
  const evidenceHash = createHash("sha256").update(suffix).digest("hex");
  let adminId;
  let taxPolicyId;
  let packageProfileId;
  let servicePolicyId;

  try {
    const [owner] = await db.insert(adminUsers).values({
      providerUserId: "readiness-evidence-" + suffix,
      email: "readiness-evidence-" + suffix + "@example.invalid",
      emailNormalized: "readiness-evidence-" + suffix + "@example.invalid",
      displayName: "Nataliea Lavoie",
      role: "owner",
    }).returning({ id: adminUsers.id });
    adminId = owner.id;

    await assert.rejects(
      db.insert(shippingPackageProfiles).values({
        slug: "invalid-" + suffix,
        name: "Invalid package",
        rank: 1,
        packageType: "parcel",
        lengthCm: 10,
        widthCm: 10,
        heightCm: 10,
        tareWeightGrams: 10,
        maxWeightGrams: 100,
        capacityUnits: 1,
        enabled: true,
        reviewedAt,
      }),
      (error) => {
        assert.match(
          error?.cause?.message ?? String(error),
          /shipping_package_profiles_enabled_evidence_check/,
        );
        return true;
      },
    );
    const [packageProfile] = await db.insert(shippingPackageProfiles).values({
      slug: "valid-" + suffix,
      name: "Owner-reviewed package",
      rank: 1,
      packageType: "parcel",
      lengthCm: 10,
      widthCm: 10,
      heightCm: 10,
      tareWeightGrams: 10,
      maxWeightGrams: 100,
      capacityUnits: 1,
      enabled: true,
      reviewedAt,
      reviewedByAdminUserId: owner.id,
      reviewStepUpAuthenticatedAt: reviewedAt,
      evidenceReference: "test://package/" + suffix,
      reviewEvidenceHash: evidenceHash,
      reviewEvidenceVersion: "package-review/v1",
      reviewAction: "approve_shipping_package_profile",
    }).returning({ id: shippingPackageProfiles.id });
    packageProfileId = packageProfile.id;

    await assert.rejects(
      db.insert(shippingServicePolicies).values({
        postageType: "invalid-" + suffix,
        destinationCountryCode: "CA",
        insuranceLimitCents: 1000,
        claimWaitingDays: 1,
        claimDeadlineDays: 30,
        reviewedAt,
        enabled: true,
      }),
      (error) => {
        assert.match(
          error?.cause?.message ?? String(error),
          /shipping_service_policies_enabled_evidence_check/,
        );
        return true;
      },
    );
    const [servicePolicy] = await db.insert(shippingServicePolicies).values({
      postageType: "valid-" + suffix,
      destinationCountryCode: "CA",
      insuranceLimitCents: 1000,
      claimWaitingDays: 1,
      claimDeadlineDays: 30,
      reviewedAt,
      reviewedByAdminUserId: owner.id,
      reviewStepUpAuthenticatedAt: reviewedAt,
      evidenceReference: "test://service/" + suffix,
      reviewEvidenceHash: evidenceHash,
      reviewEvidenceVersion: "service-review/v1",
      reviewAction: "approve_shipping_service_policy",
      enabled: true,
    }).returning({ id: shippingServicePolicies.id });
    servicePolicyId = servicePolicy.id;

    await assert.rejects(
      db.insert(productTaxPolicyVersions).values({
        version: "invalid-" + suffix,
        status: "effective",
        coverage: {
          merchandise: true,
          shipping: true,
          supplements: true,
          usOrders: true,
          componentRefunds: true,
        },
        ownerName: "Arbitrary Reviewer",
        evidenceReference: "",
        approvedAt: reviewedAt,
        effectiveAt: reviewedAt,
      }),
      (error) => {
        assert.match(
          error?.cause?.message ?? String(error),
          /product_tax_policy_versions_effective_evidence_check/,
        );
        return true;
      },
    );
    const [taxPolicy] = await db.insert(productTaxPolicyVersions).values({
      version: "valid-" + suffix,
      status: "draft",
      coverage: {
        merchandise: true,
        shipping: true,
        supplements: true,
        usOrders: true,
        componentRefunds: true,
      },
      ownerName: "Nataliea Lavoie",
      evidenceReference: "test://tax/" + suffix,
      approvedByAdminUserId: owner.id,
      approvalStepUpAuthenticatedAt: reviewedAt,
      approvalEvidenceHash: evidenceHash,
      approvalEvidenceVersion: "product-tax-attestation/v1",
      approvalAction: "approve_product_tax_policy",
      approvedAt: reviewedAt,
      effectiveAt: reviewedAt,
    }).returning({ id: productTaxPolicyVersions.id });
    taxPolicyId = taxPolicy.id;
  } finally {
    if (taxPolicyId) await db.delete(productTaxPolicyVersions).where(eq(productTaxPolicyVersions.id, taxPolicyId));
    if (servicePolicyId) await db.delete(shippingServicePolicies).where(eq(shippingServicePolicies.id, servicePolicyId));
    if (packageProfileId) await db.delete(shippingPackageProfiles).where(eq(shippingPackageProfiles.id, packageProfileId));
    if (adminId) await db.delete(adminUsers).where(eq(adminUsers.id, adminId));
    await closePrivateDbPool();
  }
`;

test(
  "readiness controls reject unverified tax, package, and service activation",
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
